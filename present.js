// ============================================================
//  present.js  ―  教室のスクリーンに映す画面
// ============================================================

import {
  auth, db, signInAsGuest, getRoomIdFromUrl, escapeHtml, formatTime,
  setupTabs, studentUrl, REACTIONS,
  collection, doc, getDocs, updateDoc, onSnapshot,
  query, orderBy, limit, increment, writeBatch,
} from "./common.js";

const roomId = getRoomIdFromUrl();
const $ = (id) => document.getElementById(id);

if (!roomId) {
  document.body.innerHTML =
    '<p class="fatal">URL の末尾に ?r=部屋ID を付けてください。</p>';
  throw new Error("no room id");
}

setupTabs("#tabs");

// --- QRコードを描く（ログインを待たずに先に表示する）---------
$("roomCode").textContent = roomId;
QRCode.toCanvas($("qr"), studentUrl(roomId), { width: 190, margin: 1 });

// --- ログイン（匿名）してから中身を読み込む ------------------
const user = await signInAsGuest();

let room = null;
let commentDocs = [];   // いま持っているコメント
let questionDocs = [];  // いま持っている質問
let activePoll = null;  // いま出題中の投票 { id, data }

// --- 部屋の情報 --------------------------------------------
onSnapshot(doc(db, "rooms", roomId), (snap) => {
  if (!snap.exists()) { $("roomTitle").textContent = "部屋が見つかりません"; return; }
  room = snap.data();
  $("roomTitle").textContent = room.title || "授業ライブ";

  // この画面を先生自身が開いているときだけ、リセットボタンを出す
  updateResetButton();

  // 承認制の切り替えを、その場で画面に反映する
  renderComments();
  renderQuestions();
});

// 承認制がONなら承認済みだけ映す
const showable = (d) => !d.hidden && (!room?.moderation || d.approved);

// ============================================================
//  リアクションの合計（画面の右上に出す）
// ============================================================
onSnapshot(doc(db, "rooms", roomId, "meta", "reactions"), (snap) => {
  const d = snap.data() || {};
  const shown = REACTIONS.filter((r) => (d[r.key] || 0) > 0);
  $("reactTotal").innerHTML = shown
    .map((r) => `<span class="rt"><b>${r.emoji}</b> ${d[r.key]}</span>`)
    .join("");
});

// ============================================================
//  コメント
// ============================================================
onSnapshot(
  query(collection(db, "rooms", roomId, "comments"),
        orderBy("createdAt", "desc"), limit(60)),
  (snap) => { commentDocs = snap.docs; renderComments(); }
);

function renderComments() {
  const items = commentDocs.map((d) => d.data()).filter(showable);
  $("commentWall").innerHTML = items.length
    ? items.map((c) => `
        <div class="tile">
          <p>${escapeHtml(c.text)}</p>
          <time>${formatTime(c.createdAt)}</time>
        </div>`).join("")
    : '<p class="empty">コメントを待っています…</p>';
}

// ============================================================
//  投票の結果
// ============================================================
//  設問の文章は表示しません（先生がスライドで見せる前提）。

let resultsUnsub = null;

onSnapshot(
  query(collection(db, "rooms", roomId, "polls"),
        orderBy("createdAt", "desc"), limit(10)),
  (snap) => {
    const active = snap.docs.find((d) => d.data().active);
    if (resultsUnsub) { resultsUnsub(); resultsUnsub = null; }

    if (!active) {
      activePoll = null;
      updateResetButton();
      $("pollArea").innerHTML = '<p class="empty">実施中の投票はありません。</p>';
      return;
    }
    activePoll = { id: active.id, data: active.data() };
    updateResetButton();
    watchResults(active.id, active.data());
  }
);

function watchResults(pollId, poll) {
  resultsUnsub = onSnapshot(
    collection(db, "rooms", roomId, "polls", pollId, "responses"),
    (snap) => {
      const counts = new Array(poll.options.length).fill(0);
      snap.forEach((d) => {
        const c = d.data().choice;
        if (counts[c] !== undefined) counts[c]++;
      });
      const max = Math.max(1, ...counts);
      const isScale = poll.type === "scale";

      // 棒は .bars で囲みます（色を「何本目か」で決めているため）
      $("pollArea").innerHTML = `
        <p class="votecount">${snap.size} 人が回答</p>
        <div class="bars">
          ${poll.options.map((opt, i) => `
            <div class="bar-row big ${isScale ? "scale" : ""}">
              <div class="bar-label">${escapeHtml(opt)}</div>
              <div class="bar-track">
                <div class="bar-fill" style="width:${(counts[i] / max) * 100}%"></div>
              </div>
              <div class="bar-num">${counts[i]}</div>
            </div>`).join("")}
        </div>
      `;
    }
  );
}

// ============================================================
//  結果のリセット
// ============================================================
//  回答を全部消して、学生がもう一度投票できるようにします。
//  先生（この部屋を作った人）がこの画面を開いているときだけ使えます。

function updateResetButton() {
  const isOwner = !!room && !!user && room.ownerUid === user.uid;
  $("resetBtn").classList.toggle("hidden", !(isOwner && activePoll));
}

$("resetBtn").addEventListener("click", async () => {
  if (!activePoll) return;
  if (!confirm("いまの投票結果を全部消して、やり直しますか？")) return;

  const btn = $("resetBtn");
  btn.disabled = true;
  btn.textContent = "リセット中…";

  try {
    const base = ["rooms", roomId, "polls", activePoll.id];
    const res = await getDocs(collection(db, ...base, "responses"));

    // 回答をまとめて削除する（500件ずつが上限なので分けて実行）
    for (let i = 0; i < res.docs.length; i += 400) {
      const batch = writeBatch(db);
      res.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    // この数字が変わると、学生の端末の「投票済み」の記録が無効になります
    await updateDoc(doc(db, ...base), { resetCount: increment(1) });
  } catch (err) {
    alert("リセットできませんでした。\n" + err.message);
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "結果をリセット";
  }
});

// ============================================================
//  Q&A（いいねの多い順）
// ============================================================
onSnapshot(
  query(collection(db, "rooms", roomId, "questions"),
        orderBy("likes", "desc"), limit(30)),
  (snap) => { questionDocs = snap.docs; renderQuestions(); }
);

function renderQuestions() {
  const items = questionDocs.map((d) => d.data()).filter(showable);
  $("qaWall").innerHTML = items.length
    ? items.map((q) => `
        <div class="tile qa ${q.answered ? "answered" : ""}">
          <div class="likes">👍 ${q.likes || 0}</div>
          <p>${escapeHtml(q.text)}</p>
          ${q.answered ? '<span class="badge">回答済み</span>' : ""}
        </div>`).join("")
    : '<p class="empty">質問を待っています…</p>';
}
