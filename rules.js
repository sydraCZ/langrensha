"use strict";
/* ============================================================
   rules.js —— 游戏规则配置模块
   默认规则 + localStorage 持久化,游戏运行时读取
   ============================================================ */

const DEFAULT_RULES = {
  allowSelfKnife: false,
  witchCantSaveSelf: true,
  hunterDeadByPoison: false,
  winCondition: "all_in",
};

const RULES = {
  STORAGE_KEY: "ww_rules",
  _loaded: false,
  cfg: null,

  load() {
    this._loaded = true;
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      const saved = raw ? JSON.parse(raw) : {};
      this.cfg = Object.assign({}, DEFAULT_RULES, saved);
    } catch (e) {
      this.cfg = Object.assign({}, DEFAULT_RULES);
    }
    return this.cfg;
  },

  save(cfg) {
    this.cfg = Object.assign({}, DEFAULT_RULES, cfg);
    this._loaded = true;
    try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.cfg)); } catch (e) {}
  },

  clear() {
    this.cfg = Object.assign({}, DEFAULT_RULES);
    this._loaded = true;
    try { localStorage.removeItem(this.STORAGE_KEY); } catch (e) {}
  },

  ready() {
    if (!this._loaded) this.load();
    return this.cfg;
  },
};

/* 默认加载一次 */
RULES.load();

/* ---------- 规则辅助函数 ---------- */

function ruleWolfCanTarget(selfId) {
  const rules = RULES.ready();
  return rules.allowSelfKnife
    ? (id) => S.players[id].alive && id !== selfId
    : (id) => S.players[id].alive && id !== selfId && S.players[id].role !== WOLF;
}

function ruleWitchCanSaveSelf() {
  return !RULES.ready().witchCantSaveSelf;
}

function ruleHunterCanShootOnPoison() {
  return !!RULES.ready().hunterDeadByPoison;
}

function ruleIsAllIn() {
  return RULES.ready().winCondition === "all_in";
}
