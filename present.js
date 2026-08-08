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
// 大きさを変えたいときは、この数字（画素）を変えてください
QRCode.toCanvas($("qr"), studentUrl(roomId), { width: 130, margin: 1 });

// --- QR枠はクリックで畳める（画面を広く使いたいとき用）-------
$("joinBox").addEventListener("click", () => {
  $("joinBox").classList.toggle("mini");
});

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
//  リアクション（右上の合計＋下から浮き上がるアニメーション）
// ============================================================
let prevTotals = null;   // 前回の合計。増えた分だけ絵文字を飛ばします

//  学生は1人1枚の書類にリアクションを書きます。
//  ここで全員分を足し合わせて合計を出します。
onSnapshot(collection(db, "rooms", roomId, "reacts"), (snap) => {
  const totals = {};
  REACTIONS.forEach((r) => (totals[r.key] = 0));
  snap.forEach((d) => {
    const v = d.data();
    REACTIONS.forEach((r) => (totals[r.key] += v[r.key] || 0));
  });

  const shown = REACTIONS.filter((r) => totals[r.key] > 0);
  $("reactTotal").innerHTML = shown
    .map((r) => `<span class="rt"><b>${r.emoji}</b> ${totals[r.key]}</span>`)
    .join("");

  // 画面を開いた直後は飛ばさない（前回の合計がまだ無いため）
  if (prevTotals) {
    REACTIONS.forEach((r) => {
      const delta = totals[r.key] - (prevTotals[r.key] || 0);
      // 一度にたくさん押されても、飛ぶのは最大12個までにしておきます
      if (delta > 0) floatUp(r.emoji, Math.min(delta, 12));
    });
  }
  prevTotals = totals;
});

/** 絵文字を画面の下から n 個ふわっと浮き上がらせる */
function floatUp(emoji, n) {
  const layer = $("floatLayer");
  for (let i = 0; i < n; i++) {
    const el = document.createElement("span");
    el.className = "floater";
    el.textContent = emoji;
    // 出る位置・横揺れ・傾き・速さを少しずつ散らして、自然に見せる
    el.style.left = (8 + Math.random() * 84) + "%";
    el.style.setProperty("--dx", (Math.random() * 140 - 70) + "px");
    el.style.setProperty("--rot", (Math.random() * 44 - 22) + "deg");
    el.style.animationDelay = (i * 130) + "ms";
    el.style.animationDuration = (2600 + Math.random() * 1400) + "ms";
    el.addEventListener("animationend", () => el.remove());
    layer.appendChild(el);
  }
}

// ============================================================
//  コメント
// ============================================================
// 投影画面に出すのは新しい方から12件だけ。
// 多すぎると画面からはみ出して、スクロールしないと読めなくなるためです。
// （全部の投稿は教員ページで見られます）
onSnapshot(
  query(collection(db, "rooms", roomId, "comments"),
        orderBy("createdAt", "desc"), limit(12)),
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

//  確認のダイアログは出しません（投影中に邪魔になるため）。
//  押した時点ですぐ消えます。元には戻せません。
$("resetBtn").addEventListener("click", async () => {
  if (!activePoll) return;

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

    // 消えたことが分かるように、ボタンの文字を少しだけ変える
    btn.textContent = "リセットしました ✓";
    setTimeout(() => (btn.textContent = "結果をリセット"), 1600);
  } catch (err) {
    btn.textContent = "リセットできません";
    setTimeout(() => (btn.textContent = "結果をリセット"), 2500);
    console.error(err);
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
//  Q&A（いいねの多い順）
// ============================================================
// こちらも同じ理由で、いいねの多い方から12件だけ映します
onSnapshot(
  query(collection(db, "rooms", roomId, "questions"),
        orderBy("likes", "desc"), limit(12)),
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
