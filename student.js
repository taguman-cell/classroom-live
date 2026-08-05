// ============================================================
//  student.js  ―  学生がスマホで開くページの動き
// ============================================================

import {
  auth, db, signInAsGuest, getRoomIdFromUrl, escapeHtml, formatTime,
  setupTabs, likedStore, votedStore,
  collection, doc, addDoc, setDoc, onSnapshot, query, orderBy, limit,
  serverTimestamp, increment, writeBatch,
} from "./common.js";

const roomId = getRoomIdFromUrl();
const $ = (id) => document.getElementById(id);

// 部屋IDが URL に無い場合はここで終了
if (!roomId) {
  document.body.innerHTML =
    '<p class="fatal">QRコードから開き直してください。<br>（URL に部屋IDがありません）</p>';
  throw new Error("no room id");
}

setupTabs("#tabs");

let room = null;              // 部屋の設定
let qaDocs = [];              // いま持っている質問
let commentFeedUnsub = null;  // コメント一覧の購読を止めるための関数

// --- ログイン（匿名）してから開始 ---------------------------
const user = await signInAsGuest();

// ============================================================
//  1. 部屋の情報を見張る
// ============================================================
onSnapshot(doc(db, "rooms", roomId), (snap) => {
  if (!snap.exists()) {
    $("roomTitle").textContent = "この部屋は見つかりません";
    return;
  }
  room = snap.data();
  $("roomTitle").textContent = room.title || "授業ライブ";
  $("roomState").textContent = room.open ? "受付中" : "受付を終了しました";
  $("roomState").className = "state " + (room.open ? "open" : "closed");

  // 受付終了なら入力欄を止める
  document.querySelectorAll("textarea, .composer button")
    .forEach((el) => (el.disabled = !room.open));

  // 「学生にもコメント一覧を見せる」設定に応じて購読を切り替える
  if (room.showFeedToStudents && !commentFeedUnsub) {
    startCommentFeed();
  } else if (!room.showFeedToStudents && commentFeedUnsub) {
    commentFeedUnsub();
    commentFeedUnsub = null;
    $("commentFeed").innerHTML =
      '<p class="empty">コメントは前のスクリーンに表示されます。</p>';
  }

  // 承認制の設定が変わったら、Q&A の表示もその場で切り替える
  renderQa();
});

// ============================================================
//  2. コメントタブ
// ============================================================
$("commentText").addEventListener("input", (e) => {
  $("commentCount").textContent = e.target.value.length;
});

$("commentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("commentText").value.trim();
  if (!text) return;
  try {
    await addDoc(collection(db, "rooms", roomId, "comments"), {
      text,
      uid: user.uid,
      hidden: false,
      approved: false,
      createdAt: serverTimestamp(),
    });
    $("commentText").value = "";
    $("commentCount").textContent = "0";
    flash($("commentSent"));
  } catch (err) {
    alert("送信できませんでした。受付が終了している可能性があります。");
    console.error(err);
  }
});

function startCommentFeed() {
  const q = query(
    collection(db, "rooms", roomId, "comments"),
    orderBy("createdAt", "desc"),
    limit(50)
  );
  commentFeedUnsub = onSnapshot(q, (snap) => {
    const items = snap.docs.map((d) => d.data()).filter(visibleToStudents);
    $("commentFeed").innerHTML = items.length
      ? items.map((c) => `
          <div class="card">
            <p>${escapeHtml(c.text)}</p>
            <time>${formatTime(c.createdAt)}</time>
          </div>`).join("")
      : '<p class="empty">まだコメントがありません。</p>';
  });
}

// 承認制がONなら「承認済み」のものだけ表示する
function visibleToStudents(d) {
  if (d.hidden) return false;
  if (room?.moderation && !d.approved) return false;
  return true;
}

// ============================================================
//  3. アンケートタブ
// ============================================================
const pollsQ = query(
  collection(db, "rooms", roomId, "polls"),
  orderBy("createdAt", "desc"),
  limit(10)
);

let activePollUnsub = null;

onSnapshot(pollsQ, (snap) => {
  const active = snap.docs.find((d) => d.data().active);
  if (activePollUnsub) { activePollUnsub(); activePollUnsub = null; }

  if (!active) {
    $("pollArea").innerHTML =
      '<p class="empty">いまは実施中のアンケートがありません。</p>';
    return;
  }
  renderPoll(active.id, active.data());
});

function renderPoll(pollId, poll) {
  const voted = votedStore.has(pollId);

  $("pollArea").innerHTML = `
    <h2 class="poll-q">${escapeHtml(poll.question)}</h2>
    <div id="pollOptions" class="options">
      ${poll.options.map((opt, i) => `
        <button class="option" data-i="${i}" ${voted ? "disabled" : ""}>
          ${escapeHtml(opt)}
        </button>`).join("")}
    </div>
    <p id="pollMsg" class="sent-note" ${voted ? "" : "hidden"}>✓ 回答しました</p>
    <div id="pollResults"></div>
  `;

  $("pollOptions").addEventListener("click", async (e) => {
    const btn = e.target.closest("button.option");
    if (!btn) return;
    try {
      // 1人1票にするため、ドキュメントIDを自分のUIDにする
      await setDoc(
        doc(db, "rooms", roomId, "polls", pollId, "responses", user.uid),
        { choice: Number(btn.dataset.i), createdAt: serverTimestamp() }
      );
      votedStore.set(pollId);
      $("pollOptions").querySelectorAll("button").forEach((b) => (b.disabled = true));
      btn.classList.add("chosen");
      $("pollMsg").hidden = false;
      if (poll.showResults) subscribeResults(pollId, poll);
    } catch (err) {
      alert("投票できませんでした。すでに回答済みかもしれません。");
      console.error(err);
    }
  });

  if (voted && poll.showResults) subscribeResults(pollId, poll);
}

// 結果を集計して表示する（先生が「結果を見せる」をONにしたときだけ）
function subscribeResults(pollId, poll) {
  activePollUnsub = onSnapshot(
    collection(db, "rooms", roomId, "polls", pollId, "responses"),
    (snap) => {
      const counts = new Array(poll.options.length).fill(0);
      snap.forEach((d) => {
        const c = d.data().choice;
        if (counts[c] !== undefined) counts[c]++;
      });
      const total = snap.size || 1;
      $("pollResults").innerHTML = `
        <h3 class="results-title">回答結果（${snap.size}人）</h3>
        ${poll.options.map((opt, i) => `
          <div class="bar-row">
            <div class="bar-label">${escapeHtml(opt)}</div>
            <div class="bar-track">
              <div class="bar-fill" style="width:${(counts[i] / total) * 100}%"></div>
            </div>
            <div class="bar-num">${counts[i]}</div>
          </div>`).join("")}
      `;
    }
  );
}

// ============================================================
//  4. Q&Aタブ
// ============================================================
$("qaText").addEventListener("input", (e) => {
  $("qaCount").textContent = e.target.value.length;
});

$("qaForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("qaText").value.trim();
  if (!text) return;
  try {
    await addDoc(collection(db, "rooms", roomId, "questions"), {
      text,
      uid: user.uid,
      likes: 0,
      hidden: false,
      approved: false,
      answered: false,
      createdAt: serverTimestamp(),
    });
    $("qaText").value = "";
    $("qaCount").textContent = "0";
  } catch (err) {
    alert("送信できませんでした。受付が終了している可能性があります。");
    console.error(err);
  }
});

const qaQ = query(
  collection(db, "rooms", roomId, "questions"),
  orderBy("likes", "desc"),
  limit(40)
);

onSnapshot(qaQ, (snap) => {
  qaDocs = snap.docs;
  renderQa();
});

function renderQa() {
  const liked = likedStore.get(roomId);
  const items = qaDocs.filter((d) => visibleToStudents(d.data()));

  $("qaFeed").innerHTML = items.length
    ? items.map((d) => {
        const q = d.data();
        const isLiked = liked.has(d.id);
        return `
          <div class="card qa ${q.answered ? "answered" : ""}">
            <p>${escapeHtml(q.text)}</p>
            <div class="qa-row">
              ${q.answered ? '<span class="badge">回答済み</span>' : ""}
              <button class="like ${isLiked ? "on" : ""}" data-id="${d.id}">
                👍 <span>${q.likes || 0}</span>
              </button>
            </div>
          </div>`;
      }).join("")
    : '<p class="empty">まだ質問がありません。最初の1つをどうぞ。</p>';
}

$("qaFeed").addEventListener("click", async (e) => {
  const btn = e.target.closest("button.like");
  if (!btn) return;
  const qid = btn.dataset.id;
  const liked = likedStore.get(roomId);
  const isLiked = liked.has(qid);

  // 質問の「いいね数」と「誰が押したかの記録」を同時に書き込む
  const batch = writeBatch(db);
  const qRef = doc(db, "rooms", roomId, "questions", qid);
  const vRef = doc(db, "rooms", roomId, "questions", qid, "votes", user.uid);

  if (isLiked) {
    batch.delete(vRef);
    batch.update(qRef, { likes: increment(-1) });
  } else {
    batch.set(vRef, { at: serverTimestamp() });
    batch.update(qRef, { likes: increment(1) });
  }

  try {
    await batch.commit();
    if (isLiked) liked.delete(qid); else liked.add(qid);
    likedStore.save(roomId, liked);
  } catch (err) {
    console.error(err);
  }
});

// ============================================================
//  おまけ
// ============================================================
function flash(el) {
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 2000);
}
