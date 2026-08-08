// ============================================================
//  admin.js  ―  先生用のコントロール画面
// ============================================================

import {
  auth, db, escapeHtml, formatTime, makeRoomId, studentUrl,
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  collection, doc, addDoc, setDoc, getDocs, updateDoc, deleteDoc,
  onSnapshot, query, where, orderBy, limit, serverTimestamp, writeBatch,
} from "./common.js";

const $ = (id) => document.getElementById(id);
let me = null;          // ログイン中の先生
let currentRoom = null; // いま開いている部屋のID
let unsubs = [];        // 購読の停止用
let currentTitle = "";  // いま開いている部屋の名前（削除の確認に使う）

// ============================================================
//  ログイン
// ============================================================
$("loginBtn").addEventListener("click", () => {
  signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => {
    alert("ログインできませんでした。\n" + e.message);
  });
});

onAuthStateChanged(auth, (user) => {
  // 匿名ユーザーはここでは扱わない
  if (!user || user.isAnonymous) {
    me = null;
    show("loginView");
    $("who").innerHTML = "";
    return;
  }
  me = user;
  $("who").innerHTML =
    `${escapeHtml(user.displayName || user.email)} <button id="outBtn" class="link">ログアウト</button>`;
  $("outBtn").onclick = () => signOut(auth);
  show("roomsView");
  loadRooms();
});

function show(id) {
  ["loginView", "roomsView", "roomView"].forEach((v) =>
    $(v).classList.toggle("hidden", v !== id)
  );
}

// ============================================================
//  部屋の作成・一覧
// ============================================================
$("createForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("newTitle").value.trim();
  if (!title) return;

  const id = makeRoomId();
  await setDoc(doc(db, "rooms", id), {
    title,
    ownerUid: me.uid,
    open: true,
    moderation: false,
    showFeedToStudents: false,
    createdAt: serverTimestamp(),
  });
  $("newTitle").value = "";
  loadRooms();
  openRoom(id);
});

async function loadRooms() {
  // where と orderBy を両方使うと索引作成が必要になるので、
  // 取得したあとに JavaScript 側で並べ替えています。
  const snap = await getDocs(
    query(collection(db, "rooms"), where("ownerUid", "==", me.uid), limit(50))
  );
  const rooms = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

  $("roomList").innerHTML = rooms.length
    ? rooms.map((r) => `
        <div class="card row" data-room="${r.id}">
          <div>
            <strong>${escapeHtml(r.title)}</strong>
            <div class="mono small">${r.id} ／ ${r.open ? "受付中" : "終了"}</div>
          </div>
          <div class="actions">
            <button data-open="${r.id}">開く</button>
            <button data-del="${r.id}" data-title="${escapeHtml(r.title)}"
                    class="danger">削除</button>
          </div>
        </div>`).join("")
    : '<p class="empty">まだ部屋がありません。上の欄から作成してください。</p>';
}

$("roomList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  if (btn.dataset.open) { openRoom(btn.dataset.open); return; }

  if (btn.dataset.del) {
    const id = btn.dataset.del;
    const title = btn.dataset.title;
    if (!askDeleteOk(title)) return;

    const row = btn.closest(".card");
    btn.disabled = true;
    row.classList.add("dim");
    const label = row.querySelector(".mono");
    const before = label.textContent;

    try {
      await deleteRoomCompletely(id, (msg) => (label.textContent = msg));
      loadRooms();
    } catch (err) {
      label.textContent = "削除できませんでした：" + err.message;
      setTimeout(() => { label.textContent = before; }, 4000);
      row.classList.remove("dim");
      btn.disabled = false;
      console.error(err);
    }
  }
});

$("backBtn").addEventListener("click", () => {
  stopAll();
  currentRoom = null;
  show("roomsView");
  loadRooms();
});

function stopAll() {
  unsubs.forEach((u) => u());
  unsubs = [];
}

// ============================================================
//  部屋を開く
// ============================================================
function openRoom(roomId) {
  stopAll();
  currentRoom = roomId;
  show("roomView");

  const url = studentUrl(roomId);
  $("rvCode").textContent = roomId;
  $("rvUrl").textContent = url;
  $("presentLink").href = `present.html?r=${roomId}`;
  QRCode.toCanvas($("qr"), url, { width: 170, margin: 1 });
  $("copyBtn").onclick = () => {
    navigator.clipboard.writeText(url);
    $("copyBtn").textContent = "コピーしました ✓";
    setTimeout(() => ($("copyBtn").textContent = "URLをコピー"), 1500);
  };

  // --- 部屋の設定 ---
  unsubs.push(onSnapshot(doc(db, "rooms", roomId), (snap) => {
    const r = snap.data();
    if (!r) return;
    $("rvTitle").textContent = r.title;
    currentTitle = r.title;
    $("optOpen").checked = !!r.open;
    $("optModeration").checked = !!r.moderation;
    $("optFeed").checked = !!r.showFeedToStudents;
  }));

  const setOpt = (el, field) => {
    $(el).onchange = () =>
      updateDoc(doc(db, "rooms", roomId), { [field]: $(el).checked });
  };
  setOpt("optOpen", "open");
  setOpt("optModeration", "moderation");
  setOpt("optFeed", "showFeedToStudents");

  watchComments(roomId);
  watchQuestions(roomId);
  watchPolls(roomId);
}

// ============================================================
//  部屋の削除
// ============================================================
//  Firestore は「部屋」を消しても中のコメントなどは残ってしまうので、
//  中身を先に全部消してから、最後に部屋そのものを消します。
//  （部屋を先に消すと、権限の判定ができなくなって残りが消せません）

$("deleteRoomBtn").addEventListener("click", async () => {
  if (!currentRoom) return;
  if (!askDeleteOk(currentTitle)) return;

  const btn = $("deleteRoomBtn");
  const log = $("deleteProgress");
  btn.disabled = true;
  const roomId = currentRoom;
  stopAll();   // 見張りを止めてから消す

  try {
    await deleteRoomCompletely(roomId, (msg) => (log.textContent = msg));
    currentRoom = null;
    log.textContent = "";
    show("roomsView");
    loadRooms();
  } catch (err) {
    log.textContent = "削除できませんでした：" + err.message;
    console.error(err);
  } finally {
    btn.disabled = false;
  }
});

/** 削除していいか確認する（一覧からも部屋の中からも使います）*/
function askDeleteOk(title) {
  return confirm(
    `「${title}」を削除します。\n\n` +
    `コメント・質問・投票・リアクションの記録がすべて消えます。\n` +
    `元には戻せません。よろしいですか？`
  );
}

/**
 * 部屋を中身ごと完全に消す。
 * onProgress には進行状況の文字が渡されます。
 */
async function deleteRoomCompletely(roomId, onProgress = () => {}) {
  onProgress("質問のいいね記録を削除中…");
  const qs = await getDocs(collection(db, "rooms", roomId, "questions"));
  for (const q of qs.docs) {
    await deleteAllIn(["rooms", roomId, "questions", q.id, "votes"]);
  }

  onProgress("投票の回答を削除中…");
  const ps = await getDocs(collection(db, "rooms", roomId, "polls"));
  for (const p of ps.docs) {
    await deleteAllIn(["rooms", roomId, "polls", p.id, "responses"]);
  }

  onProgress("投稿を削除中…");
  await deleteAllIn(["rooms", roomId, "questions"]);
  await deleteAllIn(["rooms", roomId, "polls"]);
  await deleteAllIn(["rooms", roomId, "comments"]);
  await deleteAllIn(["rooms", roomId, "reacts"]);

  onProgress("部屋を削除中…");
  await deleteDoc(doc(db, "rooms", roomId));   // 最後に部屋そのもの
}

/** 指定した入れ物の中身を全部消す（一度に500件までなので分けて実行）*/
async function deleteAllIn(path) {
  const snap = await getDocs(collection(db, ...path));
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

// ============================================================
//  コメントの管理
// ============================================================
function watchComments(roomId) {
  unsubs.push(onSnapshot(
    query(collection(db, "rooms", roomId, "comments"),
          orderBy("createdAt", "desc"), limit(100)),
    (snap) => {
      $("cCount").textContent = snap.size;
      $("cList").innerHTML = snap.docs.map((d) => {
        const c = d.data();
        return `
          <div class="card row ${c.hidden ? "dim" : ""}">
            <div>
              <p>${escapeHtml(c.text)}</p>
              <time>${formatTime(c.createdAt)}</time>
            </div>
            <div class="actions">
              <button data-c-approve="${d.id}" class="${c.approved ? "on" : ""}">承認</button>
              <button data-c-hide="${d.id}">${c.hidden ? "戻す" : "隠す"}</button>
              <button data-c-del="${d.id}" class="danger">削除</button>
            </div>
          </div>`;
      }).join("") || '<p class="empty">まだありません。</p>';
    }
  ));
}

$("cList").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const base = ["rooms", currentRoom, "comments"];
  if (b.dataset.cApprove) {
    const ref = doc(db, ...base, b.dataset.cApprove);
    await updateDoc(ref, { approved: !b.classList.contains("on") });
  }
  if (b.dataset.cHide) {
    const ref = doc(db, ...base, b.dataset.cHide);
    await updateDoc(ref, { hidden: b.textContent === "隠す" });
  }
  if (b.dataset.cDel && confirm("このコメントを削除しますか？")) {
    await deleteDoc(doc(db, ...base, b.dataset.cDel));
  }
});

// ============================================================
//  Q&A の管理
// ============================================================
function watchQuestions(roomId) {
  unsubs.push(onSnapshot(
    query(collection(db, "rooms", roomId, "questions"),
          orderBy("likes", "desc"), limit(100)),
    (snap) => {
      $("qCount").textContent = snap.size;
      $("qList").innerHTML = snap.docs.map((d) => {
        const q = d.data();
        return `
          <div class="card row ${q.hidden ? "dim" : ""}">
            <div>
              <p><span class="likes">👍 ${q.likes || 0}</span> ${escapeHtml(q.text)}</p>
            </div>
            <div class="actions">
              <button data-q-approve="${d.id}" class="${q.approved ? "on" : ""}">承認</button>
              <button data-q-answered="${d.id}" class="${q.answered ? "on" : ""}">回答済</button>
              <button data-q-hide="${d.id}">${q.hidden ? "戻す" : "隠す"}</button>
              <button data-q-del="${d.id}" class="danger">削除</button>
            </div>
          </div>`;
      }).join("") || '<p class="empty">まだありません。</p>';
    }
  ));
}

$("qList").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const base = ["rooms", currentRoom, "questions"];
  const on = b.classList.contains("on");
  if (b.dataset.qApprove)  await updateDoc(doc(db, ...base, b.dataset.qApprove),  { approved: !on });
  if (b.dataset.qAnswered) await updateDoc(doc(db, ...base, b.dataset.qAnswered), { answered: !on });
  if (b.dataset.qHide)     await updateDoc(doc(db, ...base, b.dataset.qHide),     { hidden: b.textContent === "隠す" });
  if (b.dataset.qDel && confirm("この質問を削除しますか？")) {
    await deleteDoc(doc(db, ...base, b.dataset.qDel));
  }
});

// ============================================================
//  投票の管理
// ============================================================
// 種類を切り替えたら、選択肢の入力欄を出し入れする
$("pollType").addEventListener("change", () => {
  $("pollOpts").classList.toggle("hidden", $("pollType").value === "scale");
});

$("pollForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const type = $("pollType").value;

  // 1〜10 の投票は、選択肢を "1".."10" として自動で作ります。
  // こうすると集計のしくみを選択肢式と共通にできます。
  const options = type === "scale"
    ? Array.from({ length: 10 }, (_, i) => String(i + 1))
    : $("pollOpts").value.split("\n").map((s) => s.trim()).filter(Boolean);

  if (type === "choice" && options.length < 2) {
    alert("選択肢を2つ以上入れてください。");
    return;
  }

  await addDoc(collection(db, "rooms", currentRoom, "polls"), {
    options, type,
    active: false,       // 「出題する」を押すと学生に出ます
    showResults: false,  // 学生にも結果を見せるか
    resetCount: 0,       // 投影画面でリセットするたびに増えます
    createdAt: serverTimestamp(),
  });
  $("pollOpts").value = "";
});

function watchPolls(roomId) {
  unsubs.push(onSnapshot(
    query(collection(db, "rooms", roomId, "polls"),
          orderBy("createdAt", "desc"), limit(30)),
    (snap) => {
      $("pollList").innerHTML = snap.docs.map((d) => {
        const p = d.data();
        return `
          <div class="card row ${p.active ? "live" : ""}">
            <div>
              <strong>${p.type === "scale" ? "1〜10 の投票" : "選択肢式"}</strong>
              <div class="small">${p.type === "scale"
                ? "1 / 2 / 3 … 10"
                : p.options.map(escapeHtml).join(" / ")}</div>
              <div class="small">${formatTime(p.createdAt)} 作成</div>
            </div>
            <div class="actions">
              <button data-p-active="${d.id}" class="${p.active ? "on" : ""}">
                ${p.active ? "出題中" : "出題する"}</button>
              <button data-p-res="${d.id}" class="${p.showResults ? "on" : ""}">結果公開</button>
              <button data-p-del="${d.id}" class="danger">削除</button>
            </div>
          </div>`;
      }).join("") || '<p class="empty">まだ投票がありません。</p>';
    }
  ));
}

$("pollList").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const base = ["rooms", currentRoom, "polls"];

  if (b.dataset.pActive) {
    const turnOn = !b.classList.contains("on");
    // 同時に出題できるのは1つだけ。ほかを閉じてから開く。
    const all = await getDocs(collection(db, ...base));
    await Promise.all(all.docs.map((d) =>
      updateDoc(doc(db, ...base, d.id),
        { active: turnOn && d.id === b.dataset.pActive })
    ));
  }
  if (b.dataset.pRes) {
    await updateDoc(doc(db, ...base, b.dataset.pRes),
      { showResults: !b.classList.contains("on") });
  }
  if (b.dataset.pDel && confirm("この投票を削除しますか？（回答も消えます）")) {
    // Firestore は親を消しても中身は残るので、回答を先に消します
    const res = await getDocs(collection(db, ...base, b.dataset.pDel, "responses"));
    await Promise.all(res.docs.map((d) => deleteDoc(d.ref)));
    await deleteDoc(doc(db, ...base, b.dataset.pDel));
  }
});
