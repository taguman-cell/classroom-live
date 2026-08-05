// ============================================================
//  common.js  ―  3つのページ（学生・投影・教員）で共通で使う部品
// ============================================================
//
//  Firebase の機能をインターネット経由で読み込んでいます。
//  npm も Node.js も不要で、ブラウザが直接ダウンロードして使います。
//
//  ※ バージョン番号（10.12.2）は変えなくて構いません。
//     Firebase コンソールに別の番号が出ていても、これで動きます。

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import {
  getAuth, signInAnonymously, onAuthStateChanged,
  GoogleAuthProvider, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  getFirestore, collection, doc, addDoc, setDoc, getDoc, getDocs,
  updateDoc, deleteDoc, onSnapshot, query, where, orderBy, limit,
  serverTimestamp, increment, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

// --- Firebase を起動する ---------------------------------
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// --- 他のファイルでも使えるように、そのまま渡す ------------
export {
  signInAnonymously, onAuthStateChanged,
  GoogleAuthProvider, signInWithPopup, signOut,
  collection, doc, addDoc, setDoc, getDoc, getDocs,
  updateDoc, deleteDoc, onSnapshot, query, where, orderBy, limit,
  serverTimestamp, increment, writeBatch,
};

// ============================================================
//  便利関数
// ============================================================

/** URL の ?r=ABC123 から部屋IDを取り出す */
export function getRoomIdFromUrl() {
  return new URLSearchParams(location.search).get("r");
}

/** 匿名ログイン（学生・投影用）。ユーザーには何も見えません */
export function signInAsGuest() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, (user) => {
      if (user) resolve(user);
    });
    signInAnonymously(auth).catch(reject);
  });
}

/** HTML に文字を安全に差し込む（タグを無効化して荒らしを防ぐ） */
export function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Firestore のタイムスタンプを "14:32" のような表示にする */
export function formatTime(ts) {
  if (!ts?.toDate) return "";
  const d = ts.toDate();
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 部屋ID（6文字）を作る。紛らわしい文字（0,O,I,1）は除いてあります */
export function makeRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** 学生用ページの URL を組み立てる */
export function studentUrl(roomId) {
  return `${location.origin}${location.pathname.replace(/[^/]*$/, "")}index.html?r=${roomId}`;
}

/** タブ切り替えの共通処理 */
export function setupTabs(navSelector) {
  const nav = document.querySelector(navSelector);
  if (!nav) return;
  nav.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (!btn) return;
    nav.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    document.getElementById("tab-" + btn.dataset.tab)?.classList.remove("hidden");
  });
}

/** 「いいね」済みかどうかを、この端末に記録しておく */
export const likedStore = {
  key: (roomId) => `liked_${roomId}`,
  get(roomId) {
    try { return new Set(JSON.parse(localStorage.getItem(this.key(roomId)) || "[]")); }
    catch { return new Set(); }
  },
  save(roomId, set) {
    localStorage.setItem(this.key(roomId), JSON.stringify([...set]));
  },
};

/** 投票済みかどうかを、この端末に記録しておく */
export const votedStore = {
  has: (pollId) => localStorage.getItem(`voted_${pollId}`) === "1",
  set: (pollId) => localStorage.setItem(`voted_${pollId}`, "1"),
};
