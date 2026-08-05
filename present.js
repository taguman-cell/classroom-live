// ============================================================
//  present.js  ―  教室のスクリーンに映す画面
// ============================================================

import {
  db, signInAsGuest, getRoomIdFromUrl, escapeHtml, formatTime,
  setupTabs, studentUrl, REACTIONS,
  collection, doc, onSnapshot, query, orderBy, limit,
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
await signInAsGuest();

let room = null;
let commentDocs = [];   // いま持っているコメント
let questionDocs = [];  // いま持っている質問

// --- 部屋の情報 --------------------------------------------
onSnapshot(doc(db, "rooms", roomId), (snap) => {
  if (!snap.exists()) { $("roomTitle").textContent = "部屋が見つかりません"; return; }
  room = snap.data();
  $("roomTitle").textContent = room.title || "授業ライブ";
  // 承認制の切り替えを、その場で画面に反映する
  renderComments();
  renderQuestions();
});

// 承認制がONなら承認済みだけ映す
const showable = (d) => !d.hidden && (!room?.moderation || d.approved);

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
      ? items.map((c) => {
          // 0 のリアクションは表示しない（画面がうるさくなるので）
          const badges = REACTIONS
            .filter((r) => (c.reactions?.[r.key] || 0) > 0)
            .map((r) => `<span class="rb">${r.emoji} ${c.reactions[r.key]}</span>`)
            .join("");
          return `
          <div class="tile">
            <p>${escapeHtml(c.text)}</p>
            <div class="tile-foot">
              <span class="rbs">${badges}</span>
              <time>${formatTime(c.createdAt)}</time>
            </div>
          </div>`;
        }).join("")
      : '<p class="empty">コメントを待っています…</p>';
}

// ============================================================
//  アンケート
// ============================================================
let resultsUnsub = null;

onSnapshot(
  query(collection(db, "rooms", roomId, "polls"),
        orderBy("createdAt", "desc"), limit(10)),
  (snap) => {
    const active = snap.docs.find((d) => d.data().active);
    if (resultsUnsub) { resultsUnsub(); resultsUnsub = null; }
    if (!active) {
      $("pollArea").innerHTML = '<p class="empty">実施中のアンケートはありません。</p>';
      return;
    }
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

      // 1〜10 の投票は縦棒グラフ、選択肢式は横棒グラフで見せる
      const body = poll.type === "scale"
        ? scaleChart(counts, max, snap.size)
        : poll.options.map((opt, i) => `
            <div class="bar-row big">
              <div class="bar-label">${escapeHtml(opt)}</div>
              <div class="bar-track">
                <div class="bar-fill" style="width:${(counts[i] / max) * 100}%"></div>
              </div>
              <div class="bar-num">${counts[i]}</div>
            </div>`).join("");

      $("pollArea").innerHTML = `
        <h2 class="poll-q big">${escapeHtml(poll.question)}</h2>
        <p class="votecount">${snap.size} 人が回答</p>
        ${body}
      `;
    }
  );
}

/** 1〜10 の投票を、縦棒グラフ＋平均値で表示する */
function scaleChart(counts, max, total) {
  const avg = total
    ? counts.reduce((s, c, i) => s + c * (i + 1), 0) / total
    : 0;
  return `
    <div class="avg">平均 <strong>${avg.toFixed(1)}</strong> <span>/ 10</span></div>
    <div class="hist">
      ${counts.map((c, i) => `
        <div class="hist-col">
          <div class="hist-num">${c || ""}</div>
          <div class="hist-bar" style="height:${(c / max) * 100}%"></div>
          <div class="hist-lab">${i + 1}</div>
        </div>`).join("")}
    </div>`;
}

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
