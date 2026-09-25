// ==UserScript==
// @name         彗星终端
// @namespace    http://tampermonkey.net/
// @version      1.2.5
// @description  QQ: 669481357
// @match        https://3dtank.com/play/*
// @match        https://*.3dtank.com/play/*
// @match        https://*.tankionline.com/play/*
// @include      https://*.test-*.tankionline.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==


// ==UserScript==
// @name         彗星终端
// @namespace    http://tampermonkey.net/
// @version      1.2.2
// @description  敌友精细轮廓、可击中颜色、自身残骸排除、敌方ID透视；新增敌方无敌期(白)与人机(紫)轮廓区分。适配 2026 新混淆 bundle。
// @match        https://3dtank.com/play/*
// @match        https://*.3dtank.com/play/*
// @match        https://*.tankionline.com/play/*
// @include      https://*.test-*.tankionline.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

// ===== 战术透视早期模型捕获（必须先于游戏 main.js 创建坦克皮肤，====
(function installTankTacticalXrayRuntime() {
    'use strict';
    const page = window;
    const GLOBAL_NAME = '__TankXrayDebugRuntime';
    const VERSION = '4.8.0-standalone';
    const STATE_EVENT = 'tank-assistant-suite:xray-state';
    const REQUEST_EVENT = 'tank-assistant-suite:xray-request';
    const TARGET_VISUAL_EVENT = 'tank-assistant-suite:native-target-state';
    const ADAPTER_NAME = '纯透视版：自身/残骸排除 + 敌友精细轮廓 + 敌方 ID';
    const RESCAN_INTERVAL_MS = 350;
    // 敌方昵称牌“强制显示”补发的最小间隔：修复“一发即走”——首次补发若时机太早/被游戏吞掉，
    // 之后游戏按距离/复活再次隐藏时不再补发。改为周期性对仍被隐藏的合格敌方重发（节流，避免刷屏）。
    const TITLE_RESEND_MS = 1000;
    const HITTABLE_SIGNAL_TTL_MS = 650;
    // 与游戏玩家标题使用完全相同的原生敌我颜色。
    const ALLY_COLOR = 3390463;   // #33BBFF
    const ENEMY_COLOR = 16737894; // #FF6666
    const HITTABLE_COLOR = 16750592; // #FF9800 可击中（瞄准）敌人
    // 敌方无敌/出生保护期（ClientTankState.SEMI_ACTIVE）轮廓色：白色。
    const INVINCIBLE_COLOR = 16777215; // #FFFFFF
    // 敌方人机（bot，含 botControl 组件）轮廓色：紫色，与真人红色区分。
    const BOT_COLOR = 16711935; // #FF00FF
    const TEAM_ALLY = 'ally';
    const TEAM_ENEMY = 'enemy';
    const TEAM_UNKNOWN = 'unknown';
    const CLIENT_STATE_DEAD = 0;
    const CLIENT_STATE_DEAD_PHANTOM = 1;
    const CLIENT_STATE_SEMI_ACTIVE = 2; // 出生/复活无敌保护期
    // 轮廓着色高频读取：对坦克状态索引与 bot 判定结果做短时缓存，避免每帧泛扫描。
    const STATE_READ_CACHE_MS = 500;
    const STATE_NULL_CACHE_MS = 150; // 读不到状态时的短缓存，兼顾性能与出生无敌窗口灵敏度
    const BOT_DETECT_CACHE_MS = 30000; // 命中“人机”后长缓存，渲染热路径不再重复探测
    const BOT_MISS_CACHE_MS = 8000;    // 未命中/超时也缓存，避免反复扫描造成卡顿
    // 坦克状态枚举字段（旧构建 izy_1，新构建 o101_1，位于坦克状态组件上）。
    const STATE_ENUM_FIELDS = Object.freeze(['o101_1', 'izy_1']);
    // 坦克状态组件在所有者上的字段（旧构建 n14t_1/e119_1/b127_1，新构建 d16b_1/h12a_1 等）。
    const TANK_COMPONENT_FIELDS = Object.freeze(['d16b_1', 'h12a_1', 'n14t_1', 'e119_1', 'b127_1']);
    const previous = page[GLOBAL_NAME];

    // 热更新时沿用已捕获对象。
    if (previous && previous.version === VERSION && typeof previous.resume === 'function') {
        previous.resume('standalone-script-reload');
        return;
    }

    const ROOT_FIELD_SPECS = Object.freeze([
        // 普通悬浮底盘皮肤创建的根节点（新构建 x14w_1，旧构建 r14t_1）。
        Object.freeze({ field: 'x14w_1', label: 'HullSkin.root' }),
        Object.freeze({ field: 'r14t_1', label: 'HullSkin.root.legacy' }),
        // 履带坦克皮肤保存的根节点（新构建 m17a_1，旧构建 z176_1）。
        Object.freeze({ field: 'm17a_1', label: 'TrackedTankSkin.root' }),
        Object.freeze({ field: 'z176_1', label: 'TrackedTankSkin.root.legacy' }),
    ]);

    // 标题（昵称牌）根节点字段：新构建 f12a_1（标题组件 Tot），旧构建 t11k_1。
    const TITLE_ROOT_FIELDS = Object.freeze(['f12a_1', 't11k_1']);
    // 敌我关系字段：新构建 o12a_1（标题组件 Tot）、q15h_1（关系组件 rzt），旧构建 i127_1。
    const TEAM_RELATION_FIELDS = Object.freeze(['o12a_1', 'q15h_1', 'i127_1']);
    // 昵称字符串字段：新构建 g12a_1（标题组件 b12b 设置），旧构建 e127_1。
    const NICKNAME_FIELDS = Object.freeze(['g12a_1', 'k12a_1', 'e127_1']);
    // 标题可见性布尔字段：新构建 t12a_1（xot() 设置），旧构建 n127_1。
    const TITLE_VISIBLE_FIELDS = Object.freeze(['t12a_1', 'n127_1']);
    const OUTLINE_GROUPS = Object.freeze([
        Object.freeze({
            kind: 'mesh',
            fields: Object.freeze([
                Object.freeze({ field: 'x3m_1', role: 'enabled' }),
                Object.freeze({ field: 'y3m_1', role: 'color' }),
                Object.freeze({ field: 'z3m_1', role: 'thick' }),
            ]),
        }),
        Object.freeze({
            kind: 'lod',
            fields: Object.freeze([
                Object.freeze({ field: 't4x_1', role: 'enabled' }),
                Object.freeze({ field: 'u4x_1', role: 'color' }),
                Object.freeze({ field: 'v4x_1', role: 'thick' }),
            ]),
        }),
    ]);

    let enabled = false;
    let idEnabled = false;
    // 队友轮廓独立开关：默认为 true，保持“轮廓一开、敌友都描边”的原有行为。
    // 关闭后仅队友（TEAM_ALLY）的坦克轮廓被强制关闭，敌方轮廓不受影响。
    let allyOutlineEnabled = true;
    // 独立版没有密码层；运行时立即进入可控制状态，具体透视开关仍默认为关闭。
    let active = true;
    let allyColor = ALLY_COLOR;
    let enemyColor = ENEMY_COLOR;
    let hittableColor = HITTABLE_COLOR;
    let invincibleColor = INVINCIBLE_COLOR;
    let botColor = BOT_COLOR;
    let changedAt = Date.now();
    let lastReason = 'bootstrap';
    let rescanTimer = null;
    let publishTimer = null;
    let lastPublishedSignature = '';
    let rootAssignments = 0;
    let capturedRootCount = 0;
    let instrumentedNodeCount = 0;
    let instrumentedMeshCount = 0;
    let instrumentedLodCount = 0;
    let overrideReads = 0;
    let fieldAssignments = 0;
    let teamAssignments = 0;
    let enemyTitleOverrideEvents = 0;
    let titleVisibilityDispatches = 0;
    let targetVisualEvents = 0;
    let targetBusEvents = 0;
    let instrumentedEntityBusCount = 0;
    let pendingTitleVisibility = null;
    let titleVisibilityEventConstructor = null;
    const hookErrors = [];
    const rootSeen = new WeakSet();
    const nodeSeen = new WeakSet();
    const rootRecords = [];
    const rootRecordByObject = new WeakMap();
    const nodeInstrumentation = new WeakMap();
    const teamByEntity = new WeakMap();
    const rootsByEntity = new WeakMap();
    const hittableUntilByEntity = new WeakMap();
    // 实体 → 治疗（Isida 奶队友）原生绿色描边信号到期时间戳。
    // 治疗描边与伤害描边同为 QMt(颜色,粗细) 事件，仅落在“被治疗队友”总线上、颜色为绿。
    // 治疗中的队友节点直接返回原生轮廓值（绿），不再被我们锁成蓝色。
    const healingUntilByEntity = new WeakMap();
    // 实体 → { at, index } 坦克状态读取短时缓存；实体 → { at, bot } 人机判定缓存。
    const stateIndexCacheByEntity = new WeakMap();
    const botDetectCacheByEntity = new WeakMap();
    // 实体 → 最近一次“出生”（观测到 SEMI_ACTIVE）时刻。
    // 出生后游戏分两段保护：①幽灵半透明段(状态=SEMI_ACTIVE) ②变实后的不朽护盾段。
    // 第②段现在直读效果模块 Fut 的 b11u_1 护盾结束时刻（有限值=护盾在 / 巨大哨兵=已结束），
    //   护盾一结束游戏当帧即把字段重置为哨兵 → 据此切色可做到 0 延迟。
    // SPAWN_PROTECT_GATE_MS：只在出生后这段时间内逐帧轮询 Fut 字段（平时不读、零开销），必须覆盖最长护盾。
    // SPAWN_PROTECT_WHITE_MS：读不到 Fut（构建差异）时的固定兜底白色窗口。
    const spawnSeenAtByEntity = new WeakMap();
    const SPAWN_PROTECT_GATE_MS = 8000;   // 出生后允许逐帧检查真实护盾的时间窗
    const SPAWN_PROTECT_WHITE_MS = 5085;  // 仅在真实护盾读不到时的兜底固定白色
    const SPAWN_START_GRACE_MS = 350;     // 出生瞬间护盾字段可能尚未置位，起始宽限（只影响开始、不影响结束 0 延迟）
    const titleRecordByOwner = new WeakMap();
    const titleRecords = [];
    const titleRootRecordByObject = new WeakMap();
    const titleRootRecords = [];
    const nicknameNodeRecordByObject = new WeakMap();
    const nicknameNodeRecords = [];

    const weakReference = (value) => typeof WeakRef === 'function'
        ? new WeakRef(value)
        : { deref: () => value };

    const isObject = (value) => value != null && (typeof value === 'object' || typeof value === 'function');
    const isSceneNode = (value) => isObject(value)
        && isObject(value.p35_1)
        && isObject(value.r35_1)
        && isObject(value.s35_1);

    const safeEntityFromOwner = (owner) => {
        if (!isObject(owner)) return null;
        // 旧构建通过 cyt() 方法返回实体；新构建组件基类 ue 把实体存在 gyw_1 字段。
        try {
            if (typeof owner.cyt === 'function') {
                const entity = owner.cyt();
                if (isObject(entity)) return entity;
            }
        } catch (_) {}
        try {
            const candidate = owner.gyw_1;
            if (isObject(candidate)) return candidate;
        } catch (_) {}
        return null;
    };

    const entityHasTag = (entity, tag) => {
        if (!isObject(entity)) return false;
        // 标签容器字段在不同构建中变化；扫描所有含 h1() 查询方法的集合型字段。
        let containers = [entity.cyq_1, entity.byq_1];
        try {
            for (const key of Object.keys(entity).slice(0, 120)) {
                const value = entity[key];
                if (isObject(value) && typeof value.h1 === 'function') containers.push(value);
            }
        } catch (_) {}
        for (const container of containers) {
            if (!isObject(container) || typeof container.h1 !== 'function') continue;
            try {
                if (container.h1(tag)) return true;
            } catch (_) {}
        }
        return false;
    };

    // 读取对象上的 ClientTankState 枚举（兼容 o101_1 新构建）/ izy_1 旧构建）。
    const readStateEnum = (component) => {
        if (!isObject(component)) return null;
        for (const field of STATE_ENUM_FIELDS) {
            const state = component[field];
            const index = Number(state?.k3_1);
            if (isObject(state) && Number.isInteger(index) && index >= 0 && index <= 4) return state;
        }
        return null;
    };

    const findTankComponent = (owner, allowGenericScan = true) => {
        if (!isObject(owner)) return null;
        for (const field of TANK_COMPONENT_FIELDS) {
            const candidate = owner[field];
            if (readStateEnum(candidate)) return candidate;
        }
        if (!allowGenericScan) return null;
        // 字段名随构建混淆时仍可从唯一的 ClientTankState 枚举结构识别组件。
        try {
            for (const field of Object.keys(owner).slice(0, 200)) {
                if (readStateEnum(owner[field])) return owner[field];
            }
        } catch (_) {}
        return null;
    };

    const readClientTankState = (record, allowGenericScan = true) => {
        const owner = record?.ownerRef?.deref?.();
        const state = readStateEnum(findTankComponent(owner, allowGenericScan));
        if (!isObject(state)) return { index: null, name: '' };
        const index = Number(state.k3_1);
        let name = '';
        try { name = String(state.j3_1 ?? state.toString?.() ?? '').toUpperCase(); } catch (_) {}
        return { index: Number.isInteger(index) ? index : null, name };
    };

    // 坦克状态索引的着色用快速读取。
    // 必须与 exclusionReason（死亡判定）使用同一条“已验证有效”的读取链：
    // 先查已定位字段，读不到则沿实体关联皮肤根、并用 generic 全属性兜底（字段名随构建混淆时需要）。
    // 结果按实体做 STATE_READ_CACHE_MS 短缓存，把 generic 扫描开销锁在每实体 ~2 次/秒。
    // SEMI_ACTIVE(2)=出生/复活无敌保护期。
    const readStateIndexForEntity = (record, entity) => {
        const now = Date.now();
        if (entity) {
            const cached = stateIndexCacheByEntity.get(entity);
            if (cached) {
                const ttl = cached.index == null ? STATE_NULL_CACHE_MS : STATE_READ_CACHE_MS;
                if (now - cached.at < ttl) return cached.index;
            }
        }
        let state = { index: null, name: '' };
        try {
            state = readClientTankState(record, false);
            if (state.index == null && entity) {
                const relatedRoots = rootsByEntity.get(entity);
                if (relatedRoots) {
                    for (const relatedRoot of relatedRoots) {
                        state = readClientTankState(relatedRoot, true);
                        if (state.index != null || state.name) break;
                    }
                }
            }
            if (state.index == null && !state.name) state = readClientTankState(record, true);
        } catch (_) { state = { index: null, name: '' }; }
        const index = state.index;
        if (entity) {
            // 读到有效状态缓存 500ms；读不到（刚生成/字段暂不可用）只缓存 150ms，
            // 避免在出生无敌窗口内恰好缓存 null 而整段漏判白色。
            stateIndexCacheByEntity.set(entity, { at: now, index });
        }
        return index;
    };

    // 人机控制组件（botControlComponent，混淆类 Qht）的判据：
    //   构造默认 this.xzu_1 = !1（真人）；人机由事件 Vht 置 true、Kht 置 false。
    //   e12u() = !this.wyx().vyo_1 && this.xzu_1 —— 即“当前由 AI 接管”。
    // 必须要求 xzu_1 === true：真人也有 Qht 但 xzu_1 恒为 false。只读数据字段，不调用 e12u/wyx（无副作用）。
    const looksLikeBotControl = (obj) => {
        if (!isObject(obj)) return false;
        try {
            return typeof obj.e12u === 'function' && obj.xzu_1 === true;
        } catch (_) { return false; }
    };

    // 移动控制组件（混淆类 Mmt，游戏谓词 Cmt 即用它判人机）：人机时 m14d_1 指向 Qht。
    const looksLikeMoveController = (obj) => {
        if (!isObject(obj)) return false;
        try {
            return obj.g14d_1 !== undefined && obj.r14d_1 !== undefined &&
                   typeof obj.h14d_1 === 'boolean' && 'm14d_1' in obj && 'q14d_1' in obj;
        } catch (_) { return false; }
    };
    // MonoBehaviour 组件：原型带上下文/宿主方法。注意组件本身也可能带 a1/g1（DI 集合），不能据此跳过。
    const isComponent = (obj) => {
        if (!isObject(obj)) return false;
        try {
            return typeof obj.uyn === 'function' || typeof obj.wyx === 'function' ||
                   typeof obj.jyw === 'function' || typeof obj.myw === 'function';
        } catch (_) { return false; }
    };
    // botControl 被游戏缓存为“控制持有组件”上的直接数据字段：
    //   nmt.g14a_1 / hmt.g14b_1 / Jgt.d149_1 → Qht；Mmt.m14d_1 → Qht。判字段值是否为“激活的”Qht。
    const BOT_HOLDER_FIELDS = Object.freeze(['d149_1', 'g14b_1', 'g14a_1']);
    const holderFieldsRevealBot = (obj) => {
        if (!isObject(obj)) return false;
        try {
            for (const field of BOT_HOLDER_FIELDS) {
                const desc = Object.getOwnPropertyDescriptor(obj, field);
                if (desc && 'value' in desc && looksLikeBotControl(desc.value)) return true;
            }
            if (looksLikeMoveController(obj) && looksLikeBotControl(obj.m14d_1)) return true;
        } catch (_) {}
        return false;
    };

    // ===== 精确路径：从 MonoBehaviour 的组件上下文枚举该坦克的“全部组件” =====
    // Alternativa 引擎结构（纯数据字段，零方法调用）：
    //   MonoBehaviour.gyw_1 -> 组件上下文 he（jyw() 即返回它；我们直接读字段，不调用）
    //   he.pyt_1            -> Nt（组件按类型分组容器）
    //   Nt.s2a_1            -> 原生 Map<组件类型id, v_ 包装>
    //   v_.c2a_1            -> 原生数组，元素即组件实例
    const isNativeMap = (o) => { try { return o instanceof Map; } catch (_) { return false; } };
    const contextFromComponent = (comp) => {
        if (!isObject(comp)) return null;
        try {
            const d = Object.getOwnPropertyDescriptor(comp, 'gyw_1');
            if (d && 'value' in d && isObject(d.value)) return d.value;
        } catch (_) {}
        return null;
    };
    // 从上下文 he（或 Nt）里收集全部组件实例：只读原生 Map/数组，绝不调用游戏方法。
    const collectComponentsFromContext = (ctx, sink, budget) => {
        if (!isObject(ctx) || budget.n <= 0) return;
        const maps = [];
        try {
            const d = Object.getOwnPropertyDescriptor(ctx, 'pyt_1');
            if (d && 'value' in d && isObject(d.value) && isNativeMap(d.value.s2a_1)) maps.push(d.value.s2a_1);
            if (isNativeMap(ctx.s2a_1)) maps.push(ctx.s2a_1); // ctx 本身即 Nt
        } catch (_) { return; }
        for (const map of maps) {
            let wrappers = [];
            try { wrappers = Array.from(map.values()); } catch (_) { continue; } // 原生 Map.values，零副作用
            for (const wrapper of wrappers) {
                if (budget.n <= 0) return;
                if (!isObject(wrapper)) continue;
                let arr = null;
                try {
                    const ad = Object.getOwnPropertyDescriptor(wrapper, 'c2a_1');
                    if (ad && 'value' in ad && Array.isArray(ad.value)) arr = ad.value;
                } catch (_) { continue; }
                if (!arr) continue;
                for (const comp of arr) {
                    if (budget.n <= 0) return;
                    budget.n -= 1;
                    if (isObject(comp)) sink.add(comp);
                }
            }
        }
    };

    // 从装箱数值类型（Hj/Fu：this.b1b_1 = value；或其它装箱）里取出原始数字。纯数据、零方法调用。
    const unboxNumeric = (v) => {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (!isObject(v)) return null;
        try {
            if (typeof v.b1b_1 === 'number') return v.b1b_1;
            for (const key of Object.keys(v).slice(0, 16)) {
                const d = Object.getOwnPropertyDescriptor(v, key);
                const val = d && 'value' in d ? d.value : undefined;
                if (typeof val === 'number' && Number.isFinite(val)) return val;
            }
        } catch (_) {}
        return null;
    };

    // 收集 MonoBehaviour 种子：皮肤 owner、其链到的坦克状态组件、实体自身（若为组件）。
    const collectTankSeedComponents = (entity) => {
        const seeds = [];
        const push = (o) => { if (isObject(o) && !seeds.includes(o)) seeds.push(o); };
        try {
            const relatedRoots = rootsByEntity.get(entity);
            if (relatedRoots) {
                for (const rec of relatedRoots) {
                    const owner = rec.ownerRef?.deref?.();
                    if (isObject(owner)) {
                        if (isComponent(owner)) push(owner);
                        try { push(findTankComponent(owner, false)); } catch (_) {}
                        break;
                    }
                }
            }
        } catch (_) {}
        if (isComponent(entity)) push(entity);
        return seeds;
    };

    // 枚举该坦克“全部组件”：种子 + gyw_1 上下文组件 Map（纯数据、零方法调用）。
    const collectTankComponents = (entity) => {
        const comps = new Set();
        const contexts = new Set();
        const budget = { n: 600 };
        for (const seed of collectTankSeedComponents(entity)) {
            if (isComponent(seed)) comps.add(seed);
            const ctx = contextFromComponent(seed);
            if (ctx && !contexts.has(ctx)) {
                contexts.add(ctx);
                collectComponentsFromContext(ctx, comps, budget);
            }
        }
        return comps;
    };

    // 不朽护盾（Immortality）：坦克属性/效果模块 Fut。游戏原生判定 qut(t)= s11t_1 && !w11t_1 && put(t)...
    // 最可靠的纯数据信号是“剩余进度”字段：Fut.c11u_1 是 Qut(t){this.s11u_1=t} 数字包装。
    //   护盾在 → s11u_1 = 剩余分数(1→0)；护盾结束 → 游戏每帧把它赋为 0（并把 b11u_1 重置为哨兵）。
    //   这是普通数字，无装箱陷阱，护盾一结束当帧即 0 → 0 延迟切色。
    // 辅助信号：Fut.b11u_1 = 护盾结束时刻（装箱），有限值=护盾在 / 巨大哨兵=结束（装箱结构因版本可能读不到）。
    const IMMORTALITY_SENTINEL = 1e30; // 34028235e31 判定阈值
    const immortalityCompByEntity = new WeakMap(); // 实体 → Fut 组件（缓存后每帧只读字段）
    const ownNum = (obj, key) => {
        try {
            const d = Object.getOwnPropertyDescriptor(obj, key);
            return d && 'value' in d && typeof d.value === 'number' ? d.value : null;
        } catch (_) { return null; }
    };
    // 识别 Fut：独有字段 c11u_1(进度) + b11u_1(结束时刻) 同现。
    const looksLikeImmortalityModule = (comp) => {
        if (!isObject(comp)) return false;
        try {
            const prog = comp.c11u_1;
            return isObject(prog) && ownNum(prog, 's11u_1') !== null && ('b11u_1' in comp);
        } catch (_) { return false; }
    };
    // 返回：true=护盾在（白）；false=护盾已结束（当帧切色，0 延迟）；null=读不到（交给时间窗兜底）。
    const readImmortalityShieldActive = (entity) => {
        if (!isObject(entity)) return null;
        try {
            let fut = immortalityCompByEntity.get(entity) || null;
            if (!fut || !isObject(fut)) {
                for (const comp of collectTankComponents(entity)) {
                    if (looksLikeImmortalityModule(comp)) { fut = comp; immortalityCompByEntity.set(entity, fut); break; }
                }
                if (!fut) return null; // 找不到 Fut：结构差异，走兜底
            }
            // 主信号：剩余进度分数 s11u_1（普通数字，结束即 0）。
            const frac = ownNum(fut.c11u_1, 's11u_1');
            if (frac !== null && frac > 0.01) return true;
            // 辅助信号：结束时刻 b11u_1 有限值=护盾在。
            const end = unboxNumeric(fut.b11u_1);
            if (end !== null) return end < IMMORTALITY_SENTINEL;
            // 两个信号都读不到数值 → 交给时间窗兜底（不武断判结束，避免漏白）。
            return null;
        } catch (_) { return null; }
    };

    // 重对象一律不遍历：场景节点(p35_1/r35_1/s35_1)、DOM、纯 ECS/DI 集合容器、服务事件总线。
    // 注意：MonoBehaviour 组件（含 Mmt/Qht/Fut）本身也可能带 a1/g1，但它们是“组件”而非“纯容器”，必须放行。
    const isHeavyObject = (obj) => {
        if (!isObject(obj)) return true;
        try {
            if (obj === page || obj === document || obj.nodeType) return true;
            if (isSceneNode(obj)) return true;                                  // 渲染场景节点
            if (typeof obj.a1 === 'function' && typeof obj.g1 === 'function' && !isComponent(obj)) return true; // 纯集合容器
            if (typeof obj.e1 === 'function' && typeof obj.g1 === 'function' && !isComponent(obj)) return true; // 纯列表容器
            if (typeof obj.iyz === 'function' && typeof obj.kyy === 'function' && !isComponent(obj)) return true; // 服务事件总线/上下文
        } catch (_) {}
        return false;
    };

    // 仅读取“数据属性”（value 描述符），跳过所有 getter：不触发游戏惰性 getter 抛异常。
    const safeDataProps = (obj) => {
        const out = [];
        let keys = [];
        try { keys = Object.keys(obj); } catch (_) { return out; }
        for (const key of keys) {
            let desc = null;
            try { desc = Object.getOwnPropertyDescriptor(obj, key); } catch (_) { desc = null; }
            if (!desc || !('value' in desc)) continue;   // 跳过 getter / setter
            const value = desc.value;
            if (isObject(value) && !isHeavyObject(value)) out.push(value);
        }
        return out;
    };

    // 判断一辆坦克是否为人机。
    // 主路径（精确、零方法调用）：取 MonoBehaviour 的组件上下文 gyw_1，枚举 pyt_1.s2a_1 原生 Map
    //   里该坦克的“全部组件”，找 xzu_1===true 的 Qht（人机），或持有字段 d149_1/g14b_1/g14a_1/Mmt.m14d_1
    //   指向激活 Qht 的组件。种子用皮肤 owner 与 findTankComponent 已定位的状态组件（与状态读取同源、已验证可达）。
    // 兜底（构建差异导致结构不符时）：沿数据属性做有界 BFS。两路都跳过 getter/场景节点/DOM，带硬预算并长缓存。
    const detectBotEntity = (entity) => {
        if (!isObject(entity)) return false;
        const now = Date.now();
        const cached = botDetectCacheByEntity.get(entity);
        if (cached && now - cached.at < (cached.bot ? BOT_DETECT_CACHE_MS : BOT_MISS_CACHE_MS)) {
            return cached.bot;
        }
        let bot = false;
        let seedComps = [];
        try {
            // 主路径：枚举该坦克全部组件（gyw_1 上下文组件 Map），找人机控制标志。
            const comps = collectTankComponents(entity);
            for (const comp of comps) {
                if (looksLikeBotControl(comp) || holderFieldsRevealBot(comp)) { bot = true; break; }
            }

            // 兜底 BFS：结构异常时沿数据属性有界搜索。
            if (!bot) {
                seedComps = collectTankSeedComponents(entity);
                const TIME_BUDGET_MS = 5;
                const MAX_OBJECTS = 200;
                const MAX_DEPTH = 5;
                const MAX_THROWS = 6;
                const queue = [];
                const seen = new Set();
                const enqueue = (o, d) => {
                    if (isObject(o) && !isHeavyObject(o) && !seen.has(o)) { seen.add(o); queue.push({ o, d }); }
                };
                for (const seed of seedComps) enqueue(seed, 0);
                enqueue(entity, 0);
                let processed = 0, throws = 0;
                while (queue.length && processed < MAX_OBJECTS) {
                    if (Date.now() - now > TIME_BUDGET_MS) break;
                    const { o: current, d: depth } = queue.shift();
                    processed += 1;
                    if (looksLikeBotControl(current) || holderFieldsRevealBot(current)) { bot = true; break; }
                    if (depth >= MAX_DEPTH) continue;
                    let children = [];
                    try { children = safeDataProps(current); } catch (_) { throws += 1; if (throws > MAX_THROWS) break; continue; }
                    for (const child of children) {
                        if (seen.has(child)) continue;
                        seen.add(child);
                        queue.push({ o: child, d: depth + 1 });
                        if (queue.length > MAX_OBJECTS) break;
                    }
                }
            }
        } catch (_) { bot = false; }
        // 命中真人机缓存 30s；未命中/超时缓存 8s，避免渲染热路径反复探测。
        botDetectCacheByEntity.set(entity, { at: Date.now(), bot });
        return bot;
    };

    const exclusionReason = (record) => {
        if (!record) return '';
        const entity = record.entityRef?.deref?.() || safeEntityFromOwner(record.ownerRef?.deref?.());
        if (entityHasTag(entity, 'LocalTank')) return 'local';
        // 先走已定位的皮肤/标题控制器字段，避免每个渲染帧扫描 UserTitle 的全部属性。
        let state = readClientTankState(record, false);
        // UserTitle(Mot) 自身不保存 tankComponent，沿实体关联回坦克皮肤读取状态。
        if (state.index == null && entity) {
            const relatedRoots = rootsByEntity.get(entity);
            if (relatedRoots) {
                for (const relatedRoot of relatedRoots) {
                    state = readClientTankState(relatedRoot);
                    if (state.index != null || state.name) break;
                }
            }
        }
        if (state.index == null && !state.name) state = readClientTankState(record, true);
        if (state.index === CLIENT_STATE_DEAD || state.index === CLIENT_STATE_DEAD_PHANTOM
            || state.name === 'DEAD' || state.name === 'DEAD_PHANTOM') {
            return 'dead';
        }
        // 本地坦克通常没有远端玩家标题，因此不会收到 i127_1 敌我关系赋值；
        // 当前构建若暂时读不到 LocalTank 标签，只对“已关联 tankComponent 且无敌我关系”
        // 的坦克根节点启用这个后备判定；远端坦克一旦收到关系赋值会自动恢复透视。
        const owner = record.ownerRef?.deref?.();
        const isTankRootRecord = record.sources instanceof Set;
        if (isTankRootRecord && entity && findTankComponent(owner, false)
            && (teamByEntity.get(entity) || record.team || TEAM_UNKNOWN) === TEAM_UNKNOWN) {
            return 'local';
        }
        return '';
    };

    const isXrayEligible = (record) => exclusionReason(record) === '';

    const classifyTeamRelation = (value) => {
        if (!isObject(value)) return TEAM_UNKNOWN;
        const index = Number(value.k3_1);
        if (index === 0) return TEAM_ALLY;
        if (index === 1) return TEAM_ENEMY;
        let name = '';
        try { name = String(value.j3_1 ?? value.toString?.() ?? '').toUpperCase(); } catch (_) {}
        if (name.includes('ALLY')) return TEAM_ALLY;
        if (name.includes('ENEMY')) return TEAM_ENEMY;
        return TEAM_UNKNOWN;
    };

    const attachRootToEntity = (record, entity) => {
        if (!record || !isObject(entity)) return false;
        record.entityRef = weakReference(entity);
        record.team = teamByEntity.get(entity) || record.team || TEAM_UNKNOWN;
        let records = rootsByEntity.get(entity);
        if (!records) {
            records = new Set();
            rootsByEntity.set(entity, records);
        }
        records.add(record);
        // 拦截该坦克实体的事件总线，捕获瞄准可击中等原生描边上色事件。
        instrumentEntityBus(entity);
        return true;
    };

    const associateRootOwner = (record, owner) => {
        const entity = safeEntityFromOwner(owner);
        return entity ? attachRootToEntity(record, entity) : false;
    };

    const updateEntityTeam = (entity, team) => {
        if (!isObject(entity) || team === TEAM_UNKNOWN) return;
        teamByEntity.set(entity, team);
        const records = rootsByEntity.get(entity);
        if (records) for (const record of records) record.team = team;
    };

    const teamForNodeRecord = (nodeRecord) => {
        const rootRecord = nodeRecord?.rootRecord;
        let team = rootRecord?.team || TEAM_UNKNOWN;
        const entity = rootRecord?.entityRef?.deref?.();
        if (entity) team = teamByEntity.get(entity) || team;
        return team;
    };

    // 是否处于“出生保护”整段窗口（幽灵段 SEMI_ACTIVE + 变实后的不朽护盾段）。
    // 观测到敌人状态变为 SEMI_ACTIVE(2) 即视为一次出生，锚定时刻；此后 SPAWN_PROTECT_WHITE_MS 内白色。
    const isSpawnProtectingEntity = (entity, stateIndex, now) => {
        if (!entity) return false;
        if (stateIndex === CLIENT_STATE_SEMI_ACTIVE) {
            const prev = spawnSeenAtByEntity.get(entity);
            // 距上次出生超过窗口，说明是一次新的出生/复活，重新锚定。
            if (!prev || now - prev > SPAWN_PROTECT_GATE_MS) spawnSeenAtByEntity.set(entity, now);
            return true;
        }
        const spawnAt = spawnSeenAtByEntity.get(entity);
        if (!spawnAt) return false;
        const sinceSpawn = now - spawnAt;
        if (sinceSpawn > SPAWN_PROTECT_GATE_MS) return false; // 出生保护窗已过，不再检查
        // 直读不朽护盾模块 Fut.b11u_1：true=护盾在（白）；false=护盾已结束，当帧切色（0 延迟）。
        const shield = readImmortalityShieldActive(entity);
        if (shield === true) return true;
        if (shield === false) {
            // 护盾确实已结束：给一个极小的起始宽限（护盾字段可能刚好处在出生瞬间尚未置位），
            // 之后完全以真实护盾为准 —— 结束时刻 0 延迟。
            return sinceSpawn < SPAWN_START_GRACE_MS;
        }
        // shield === null：该构建读不到 Fut，退回固定白色窗口兜底。
        return sinceSpawn < SPAWN_PROTECT_WHITE_MS;
    };

    const colorForNode = (nodeRecord) => {
        const rootRecord = nodeRecord?.rootRecord;
        const entity = rootRecord?.entityRef?.deref?.();
        const team = teamForNodeRecord(nodeRecord);
        if (team === TEAM_ALLY) return allyColor;
        if (team === TEAM_ENEMY && entity) {
            const now = Date.now();
            const stateIndex = readStateIndexForEntity(rootRecord, entity);
            // 1) 无敌/出生保护期（幽灵段 SEMI_ACTIVE + 变实后的不朽护盾段）：白色，优先级最高。
            if (isSpawnProtectingEntity(entity, stateIndex, now)) return invincibleColor;
            // 2) 当前可击中（瞄准信号 TTL 内）：橙色。
            if ((hittableUntilByEntity.get(entity) || 0) > now) return hittableColor;
            // 3) 人机 vs 真人：人机紫色，真人默认红色。
            if (detectBotEntity(entity)) return botColor;
        }
        return enemyColor;
    };

    // 是否为“当前可击中”的敌方坦克：处于瞄准可击中信号 TTL 内。
    const isHittableNode = (nodeRecord) => {
        const rootRecord = nodeRecord?.rootRecord;
        const entity = rootRecord?.entityRef?.deref?.();
        if (!entity) return false;
        return teamForNodeRecord(nodeRecord) === TEAM_ENEMY
            && (hittableUntilByEntity.get(entity) || 0) > Date.now();
    };

    // 是否为“正在被治疗（奶）”的队友坦克：治疗绿描边信号 TTL 内且为我方。
    const isHealingAllyNode = (nodeRecord) => {
        const rootRecord = nodeRecord?.rootRecord;
        const entity = rootRecord?.entityRef?.deref?.();
        if (!entity) return false;
        return teamForNodeRecord(nodeRecord) === TEAM_ALLY
            && (healingUntilByEntity.get(entity) || 0) > Date.now();
    };

    const effectiveValue = (role, originalValue, nodeRecord) => {
        if (!active || !enabled) return originalValue;
        const excluded = exclusionReason(nodeRecord?.rootRecord);
        if (excluded) {
            // “排除”必须真正关闭轮廓。当前客户端会给本地坦克和死亡材质保留原生 enabled=true；若只是返回 originalValue，截图中的绿色蓝色残留仍会出现。
            if (role === 'enabled' || role === 'thick') return false;
            return originalValue;
        }
        // 正在被治疗（奶）的队友：直接透出游戏原生绿色治疗描边，不覆盖成我们的队友蓝，也不受“队友轮廓开关”影响。
        if (isHealingAllyNode(nodeRecord)) return originalValue;
        // 队友轮廓独立开关：关闭时把队友坦克的轮廓真正关掉（与排除同路径），
        // 敌方轮廓不受影响。
        if (!allyOutlineEnabled && teamForNodeRecord(nodeRecord) === TEAM_ALLY) {
            if (role === 'enabled' || role === 'thick') return false;
            return originalValue;
        }
        if (role === 'enabled') return true;
        // z3m_1 / v4x_1 为原生粗描边位；默认关闭得到更细、更完整的模型边缘；
        // 仅“当前可击中”的敌方坦克打开粗描边，让可击中橙色轮廓明显加粗。
        if (role === 'thick') return isHittableNode(nodeRecord);
        if (role === 'color') return colorForNode(nodeRecord);
        return originalValue;
    };

    const safeListItems = (list) => {
        if (!isObject(list) || typeof list.e1 !== 'function' || typeof list.g1 !== 'function') return [];
        try {
            const rawCount = Number(list.e1());
            if (!Number.isInteger(rawCount) || rawCount < 0 || rawCount > 2048) return [];
            const items = [];
            for (let index = 0; index < rawCount; index += 1) {
                const item = list.g1(index);
                if (isObject(item)) items.push(item);
            }
            return items;
        } catch (_) {
            return [];
        }
    };

    const isEnemyTitleRoot = (record) => {
        if (!record) return false;
        const entity = record.entityRef?.deref?.();
        if (entity) record.team = teamByEntity.get(entity) || record.team || TEAM_UNKNOWN;
        return record.team === TEAM_ENEMY && isXrayEligible(record);
    };

    const instrumentTitleTree = (root, titleRootRecord) => {
        if (!isSceneNode(root)) return { nodes: 0 };
        const visited = new WeakSet();
        const stack = [root];
        let nodes = 0;
        while (stack.length > 0 && nodes < 2048) {
            const node = stack.pop();
            if (!isObject(node) || visited.has(node)) continue;
            visited.add(node);
            nodes += 1;
            for (const child of safeListItems(node.p35_1)) stack.push(child);
            for (const lodLevel of safeListItems(node.q4x_1)) stack.push(lodLevel);
        }
        titleRootRecord.lastScanAt = Date.now();
        titleRootRecord.nodeCount = nodes;
        return { nodes };
    };

    const captureTitleRoot = (owner, root) => {
        if (!isSceneNode(root)) return root;
        let record = titleRootRecordByObject.get(root);
        if (!record) {
            record = {
                rootRef: weakReference(root),
                ownerRef: isObject(owner) ? weakReference(owner) : null,
                entityRef: null,
                team: TEAM_UNKNOWN,
                capturedAt: Date.now(),
                lastScanAt: null,
                nodeCount: 0,
            };
            titleRootRecordByObject.set(root, record);
            titleRootRecords.push(record);
        } else if (isObject(owner)) {
            record.ownerRef = weakReference(owner);
        }
        const entity = safeEntityFromOwner(owner);
        if (entity) {
            record.entityRef = weakReference(entity);
            record.team = teamByEntity.get(entity) || record.team;
            instrumentEntityBus(entity);
        }
        try {
            const titleScan = instrumentTitleTree(root, record);
            record.nodeCount = titleScan.nodes;
        } catch (_) {}
        schedulePublish('title-root-captured');
        return root;
    };

    const captureNicknameSceneNode = (owner, node) => {
        if (!isSceneNode(node)) return node;
        let record = nicknameNodeRecordByObject.get(node);
        if (!record) {
            record = {
                rootRef: weakReference(node),
                ownerRef: isObject(owner) ? weakReference(owner) : null,
                entityRef: null,
                team: TEAM_UNKNOWN,
                capturedAt: Date.now(),
                lastScanAt: null,
                nodeCount: 0,
            };
            nicknameNodeRecordByObject.set(node, record);
            nicknameNodeRecords.push(record);
        } else if (isObject(owner)) {
            record.ownerRef = weakReference(owner);
        }
        const entity = safeEntityFromOwner(owner);
        if (entity) {
            record.entityRef = weakReference(entity);
            record.team = teamByEntity.get(entity) || record.team;
            // 独立昵称牌节点路径同样要确保实体事件总线被插桩，否则游戏发来的“隐藏昵称牌”事件无人拦截。
            instrumentEntityBus(entity);
        }
        instrumentTitleTree(node, record);
        schedulePublish('nickname-node-captured');
        return node;
    };

    const installOutlineAccessor = (target, spec, nodeRecord) => {
        const descriptor = Object.getOwnPropertyDescriptor(target, spec.field);
        if (!descriptor || !('value' in descriptor) || descriptor.configurable === false) return false;
        let originalValue = descriptor.value;
        try {
            Object.defineProperty(target, spec.field, {
                configurable: true,
                enumerable: descriptor.enumerable !== false,
                get() {
                    const value = effectiveValue(spec.role, originalValue, nodeRecord);
                    if (!Object.is(value, originalValue)) overrideReads += 1;
                    return value;
                },
                set(nextValue) {
                    originalValue = nextValue;
                    fieldAssignments += 1;
                },
            });
            nodeRecord.fields.add(spec.field);
            return true;
        } catch (error) {
            hookErrors.push({
                stage: 'outline-accessor',
                field: spec.field,
                message: String(error?.message || error),
            });
            return false;
        }
    };

    const instrumentNode = (node) => {
        if (!isObject(node)) return null;
        let nodeRecord = nodeInstrumentation.get(node);
        if (!nodeRecord) {
            nodeRecord = { fields: new Set(), kind: 'node' };
            nodeInstrumentation.set(node, nodeRecord);
        }

        for (const group of OUTLINE_GROUPS) {
            const ownsAllFields = group.fields.every((spec) => Object.prototype.hasOwnProperty.call(node, spec.field));
            if (!ownsAllFields) continue;
            let installedAny = false;
            for (const spec of group.fields) {
                if (nodeRecord.fields.has(spec.field)) continue;
                installedAny = installOutlineAccessor(node, spec, nodeRecord) || installedAny;
            }
            if (installedAny && nodeRecord.kind === 'node') {
                nodeRecord.kind = group.kind;
                if (group.kind === 'mesh') instrumentedMeshCount += 1;
                else instrumentedLodCount += 1;
            }
        }

        if (!nodeSeen.has(node)) {
            nodeSeen.add(node);
            instrumentedNodeCount += 1;
        }
        return nodeRecord;
    };

    const instrumentTree = (root, rootRecord = null) => {
        if (!isSceneNode(root)) return { nodes: 0, meshes: 0, lodGroups: 0 };
        const visited = new WeakSet();
        const stack = [root];
        let nodes = 0;
        let meshes = 0;
        let lodGroups = 0;

        while (stack.length > 0 && nodes < 4096) {
            const node = stack.pop();
            if (!isObject(node) || visited.has(node)) continue;
            visited.add(node);
            nodes += 1;
            const nodeRecord = instrumentNode(node);
            if (nodeRecord && rootRecord) nodeRecord.rootRecord = rootRecord;
            if (nodeRecord?.kind === 'mesh') meshes += 1;
            else if (nodeRecord?.kind === 'lod') lodGroups += 1;

            // p35_1 是通用场景子节点；q4x_1 为 LodGroup 的各级模型节点?
            for (const child of safeListItems(node.p35_1)) stack.push(child);
            for (const lodLevel of safeListItems(node.q4x_1)) stack.push(lodLevel);
        }

        if (rootRecord) {
            rootRecord.lastScanAt = Date.now();
            rootRecord.nodeCount = nodes;
            rootRecord.meshCount = meshes;
            rootRecord.lodCount = lodGroups;
        }
        return { nodes, meshes, lodGroups };
    };

    const captureRoot = (value, spec, owner) => {
        rootAssignments += 1;
        if (!isSceneNode(value)) return false;
        let record = rootRecordByObject.get(value);
        if (!record) {
            record = {
                rootRef: weakReference(value),
                ownerRef: isObject(owner) ? weakReference(owner) : null,
                entityRef: null,
                team: TEAM_UNKNOWN,
                sources: new Set([spec.field]),
                label: spec.label,
                capturedAt: Date.now(),
                lastScanAt: null,
                nodeCount: 0,
                meshCount: 0,
                lodCount: 0,
            };
            rootRecordByObject.set(value, record);
            rootRecords.push(record);
            rootSeen.add(value);
            capturedRootCount += 1;
        } else {
            record.sources.add(spec.field);
            if (isObject(owner)) record.ownerRef = weakReference(owner);
        }
        associateRootOwner(record, owner);
        instrumentTree(value, record);
        schedulePublish('tank-root-captured');
        return true;
    };

    const installRootHook = (spec) => {
        const existing = Object.getOwnPropertyDescriptor(Object.prototype, spec.field);
        if (existing) {
            hookErrors.push({
                stage: 'root-hook',
                field: spec.field,
                message: 'Object.prototype 已存在同名字段，未覆盖',
            });
            return false;
        }
        const setter = function tankTacticalXrayRootCapture(initialValue) {
            let originalValue = initialValue;
            try {
                Object.defineProperty(this, spec.field, {
                    configurable: true,
                    enumerable: true,
                    get() { return originalValue; },
                    set(nextValue) {
                        originalValue = nextValue;
                        captureRoot(nextValue, spec, this);
                    },
                });
                captureRoot(initialValue, spec, this);
            } catch (error) {
                hookErrors.push({
                    stage: 'root-instance',
                    field: spec.field,
                    message: String(error?.message || error),
                });
            }
        };
        Object.defineProperty(setter, '__tankTacticalXrayHook', { value: VERSION });
        try {
            Object.defineProperty(Object.prototype, spec.field, {
                configurable: true,
                enumerable: false,
                get: undefined,
                set: setter,
            });
            return true;
        } catch (error) {
            hookErrors.push({
                stage: 'root-hook',
                field: spec.field,
                message: String(error?.message || error),
            });
            return false;
        }
    };

    const getTitleRecord = (owner) => {
        if (!isObject(owner)) return null;
        let record = titleRecordByOwner.get(owner);
        if (!record) {
            record = {
                ownerRef: weakReference(owner),
                entityRef: null,
                team: TEAM_UNKNOWN,
                nickname: '',
                capturedAt: Date.now(),
                xrayForcedShown: false,
            };
            titleRecordByOwner.set(owner, record);
            titleRecords.push(record);
        }
        const entity = safeEntityFromOwner(owner);
        if (entity) {
            record.entityRef = weakReference(entity);
            record.team = teamByEntity.get(entity) || record.team;
        }
        return record;
    };

    const captureTeamAssignment = (owner, value) => {
        const team = classifyTeamRelation(value);
        if (team === TEAM_UNKNOWN) return value;
        teamAssignments += 1;
        const record = getTitleRecord(owner);
        if (record) record.team = team;
        const entity = safeEntityFromOwner(owner);
        if (entity) {
            if (record) record.entityRef = weakReference(entity);
            updateEntityTeam(entity, team);
        }
        schedulePublish('team-relation-captured');
        return value;
    };

    const captureNicknameAssignment = (owner, value) => {
        if (typeof value !== 'string') return value;
        const record = getTitleRecord(owner);
        if (record) record.nickname = value;
        return value;
    };

    const captureTrackedSkinAssociation = (owner, skin) => {
        if (!isObject(skin)) return skin;
        let root = null;
        // 新构建履带底盘皮肤根节点 m17a_1；旧构建 z176_1。
        for (const field of ['m17a_1', 'z176_1']) {
            try { if (isSceneNode(skin[field])) { root = skin[field]; break; } } catch (_) {}
        }
        if (!isSceneNode(root)) return skin;
        let record = rootRecordByObject.get(root);
        if (!record) {
            captureRoot(root, { field: 'trackedSkin→root', label: 'TrackedTankSkin.entityRoot' }, owner);
            record = rootRecordByObject.get(root);
        }
        if (record) {
            record.ownerRef = weakReference(owner);
            associateRootOwner(record, owner);
            instrumentTree(root, record);
        }
        schedulePublish('tracked-root-associated');
        return skin;
    };

    // 从标题记录实体读取敌我关系（不再硬编码旧字段 i127_1）。
    const resolveTitleTeam = (owner) => {
        const record = getTitleRecord(owner);
        if (record?.team && record.team !== TEAM_UNKNOWN) return record.team;
        const entity = safeEntityFromOwner(owner);
        if (entity) return teamByEntity.get(entity) || TEAM_UNKNOWN;
        return TEAM_UNKNOWN;
    };

    const prepareTitleVisibilityEvent = (owner, nextVisible) => {
        const record = getTitleRecord(owner);
        const team = resolveTitleTeam(owner);
        const forceVisible = active && idEnabled && team === TEAM_ENEMY && isXrayEligible(record);
        // 记录待处理的可见性事件，供事件重放/旧构建转换使用。
        // 注意：这里不强制改写布尔值——新构建可见性同时经由事件总线 s_t(2,hidden) 下发，
        // 强行改布尔会与游戏自身事件状态不一致；强制显示交给 dispatchEnemyTitleVisibility。
        pendingTitleVisibility = forceVisible
            ? { owner, expectedHidden: !Boolean(nextVisible) }
            : null;
        return nextVisible;
    };

    const transformTitleVisibilityEvent = (eventObject, hidden) => {
        const pending = pendingTitleVisibility;
        pendingTitleVisibility = null;
        if (typeof eventObject?.constructor === 'function' && eventObject.constructor !== Object) {
            titleVisibilityEventConstructor = eventObject.constructor;
        }
        // 旧构建事件标识在 c12b_1（事件类型=2）；新构建 s_t 事件标识 i12e_1（事件类型=2），隐藏位在 j12e_1）
        const eventId = Number(eventObject?.c12b_1 ?? eventObject?.i12e_1);
        if (!pending || eventId !== 2 || Boolean(hidden) !== pending.expectedHidden) return hidden;
        const record = getTitleRecord(pending.owner);
        const team = resolveTitleTeam(pending.owner);
        if (!active || !idEnabled || team !== TEAM_ENEMY || !isXrayEligible(record)) return hidden;
        enemyTitleOverrideEvents += 1;
        return false;
    };

    const installAssignmentHook = (field, transform, stage) => {
        const existing = Object.getOwnPropertyDescriptor(Object.prototype, field);
        if (existing) {
            hookErrors.push({ stage, field, message: 'Object.prototype 已存在同名字段，未覆盖' });
            return false;
        }
        const setter = function tankTacticalXrayAssignmentCapture(initialValue) {
            let storedValue = initialValue;
            try {
                storedValue = transform(this, initialValue);
                Object.defineProperty(this, field, {
                    configurable: true,
                    enumerable: true,
                    get() { return storedValue; },
                    set(nextValue) { storedValue = transform(this, nextValue); },
                });
            } catch (error) {
                hookErrors.push({ stage: `${stage}-instance`, field, message: String(error?.message || error) });
                try {
                    Object.defineProperty(this, field, {
                        configurable: true,
                        enumerable: true,
                        writable: true,
                        value: initialValue,
                    });
                } catch (_) {}
            }
        };
        Object.defineProperty(setter, '__tankTacticalXrayHook', { value: VERSION });
        try {
            Object.defineProperty(Object.prototype, field, {
                configurable: true,
                enumerable: false,
                get: undefined,
                set: setter,
            });
            return true;
        } catch (error) {
            hookErrors.push({ stage, field, message: String(error?.message || error) });
            return false;
        }
    };

    let installedRootHookCount = 0;
    for (const spec of ROOT_FIELD_SPECS) {
        if (installRootHook(spec)) installedRootHookCount += 1;
    }

    // 通用：为一组字段安装赋值捕获 hook（旧/新构建字段名并存，互不影响）。
    const installAssignmentHooks = (fields, transform, stage) => {
        let count = 0;
        for (const field of fields) {
            if (installAssignmentHook(field, transform, `${stage}:${field}`)) count += 1;
        }
        return count;
    };

    const teamRelationHookCount = installAssignmentHooks(TEAM_RELATION_FIELDS, captureTeamAssignment, 'team-relation-hook');
    const nicknameHookCount = installAssignmentHooks(NICKNAME_FIELDS, captureNicknameAssignment, 'nickname-hook');
    const trackedAssociationHookCount = installAssignmentHooks(['n11c_1', 'h119_1'], captureTrackedSkinAssociation, 'tracked-association-hook');
    const titleRootHookCount = installAssignmentHooks(TITLE_ROOT_FIELDS, captureTitleRoot, 'title-root-hook');
    // 昵称牌独立场景节点（旧构建 a11l_1；新构建由标题管理器 Got 方法 q11n_1，经标题根遍历覆盖）。
    const nicknameNodeHookCount = installAssignmentHooks(['q11n_1', 'a11l_1'], captureNicknameSceneNode, 'nickname-node-hook');
    // 标题可见性布尔：新构建 t12a_1（xot() 写入），旧构建 n127_1。这里仅观察/记录待处理事件。
    const titleStateHookCount = installAssignmentHooks(TITLE_VISIBLE_FIELDS, prepareTitleVisibilityEvent, 'title-state-hook');
    // 旧构建可见性事件经原型字段赋值（d12b_1）；新构建事件走事件总线，此 hook 仅对旧构建生效。
    const titleEventHookInstalled = installAssignmentHook('d12b_1', transformTitleVisibilityEvent, 'title-event-hook');
    const teamRelationHookInstalled = teamRelationHookCount > 0;
    const nicknameHookInstalled = nicknameHookCount > 0;
    const trackedAssociationHookInstalled = trackedAssociationHookCount > 0;
    const titleRootHookInstalled = titleRootHookCount > 0;
    const nicknameNodeHookInstalled = nicknameNodeHookCount > 0;
    const titleStateHookInstalled = titleStateHookCount > 0;

    const scanRoots = () => {
        let liveRoots = 0;
        let eligibleRoots = 0;
        let excludedLocalCount = 0;
        let excludedDeadCount = 0;
        let nodes = 0;
        let meshes = 0;
        let lodGroups = 0;
        let allyCount = 0;
        let enemyCount = 0;
        let unknownCount = 0;
        for (let index = rootRecords.length - 1; index >= 0; index -= 1) {
            const record = rootRecords[index];
            const root = record.rootRef.deref();
            if (!root) {
                rootRecords.splice(index, 1);
                continue;
            }
            const owner = record.ownerRef?.deref?.();
            let entity = record.entityRef?.deref?.();
            if (!entity && owner) {
                associateRootOwner(record, owner);
                entity = record.entityRef?.deref?.();
            }
            if (entity) record.team = teamByEntity.get(entity) || record.team || TEAM_UNKNOWN;
            liveRoots += 1;
            const excluded = exclusionReason(record);
            if (excluded === 'local') excludedLocalCount += 1;
            else if (excluded === 'dead') excludedDeadCount += 1;
            else {
                eligibleRoots += 1;
                if (record.team === TEAM_ALLY) allyCount += 1;
                else if (record.team === TEAM_ENEMY) enemyCount += 1;
                else unknownCount += 1;
            }
            const scan = instrumentTree(root, record);
            nodes += scan.nodes;
            meshes += scan.meshes;
            lodGroups += scan.lodGroups;
        }
        let liveTitleCount = 0;
        let enemyTitleCount = 0;
        for (let index = titleRecords.length - 1; index >= 0; index -= 1) {
            const record = titleRecords[index];
            const owner = record.ownerRef.deref();
            if (!owner) {
                titleRecords.splice(index, 1);
                continue;
            }
            liveTitleCount += 1;
            const entity = record.entityRef?.deref?.() || safeEntityFromOwner(owner);
            if (entity) {
                record.entityRef = weakReference(entity);
                record.team = teamByEntity.get(entity) || record.team;
            }
            if (record.team === TEAM_ENEMY && isXrayEligible(record)) enemyTitleCount += 1;
        }
        let liveTitleRootCount = 0;
        let enemyTitleRootCount = 0;
        for (let index = titleRootRecords.length - 1; index >= 0; index -= 1) {
            const record = titleRootRecords[index];
            const root = record.rootRef.deref();
            if (!root) {
                titleRootRecords.splice(index, 1);
                continue;
            }
            liveTitleRootCount += 1;
            const owner = record.ownerRef?.deref?.();
            const entity = record.entityRef?.deref?.() || safeEntityFromOwner(owner);
            if (entity) {
                record.entityRef = weakReference(entity);
                record.team = teamByEntity.get(entity) || record.team;
            }
            if (record.team === TEAM_ENEMY && isXrayEligible(record)) enemyTitleRootCount += 1;
            // 周期性重扫标题根：昵称牌文本节点会在运行中动态挂载。
            try {
                const titleRootNode = record.rootRef.deref();
                if (titleRootNode) instrumentTitleTree(titleRootNode, record);
            } catch (_) {}
        }
        let liveNicknameNodeCount = 0;
        let enemyNicknameNodeCount = 0;
        for (let index = nicknameNodeRecords.length - 1; index >= 0; index -= 1) {
            const record = nicknameNodeRecords[index];
            const nicknameNode = record.rootRef.deref();
            if (!nicknameNode) {
                nicknameNodeRecords.splice(index, 1);
                continue;
            }
            liveNicknameNodeCount += 1;
            const owner = record.ownerRef?.deref?.();
            const entity = record.entityRef?.deref?.() || safeEntityFromOwner(owner);
            if (entity) {
                record.entityRef = weakReference(entity);
                record.team = teamByEntity.get(entity) || record.team;
            }
            if (record.team === TEAM_ENEMY && isXrayEligible(record)) enemyNicknameNodeCount += 1;
            instrumentTitleTree(nicknameNode, record);
        }
        let hittableEnemyCount = 0;
        let invincibleEnemyCount = 0;
        let botEnemyCount = 0;
        const now = Date.now();
        for (const record of rootRecords) {
            const entity = record.entityRef?.deref?.();
            if (record.team === TEAM_ENEMY && isXrayEligible(record) && entity) {
                // 兜底：确保每个合格敌方实体的事件总线都被插桩（标题根 hook 漏掉的实例也覆盖到），幂等。
                instrumentEntityBus(entity);
                const stateIndex = readStateIndexForEntity(record, entity);
                if (isSpawnProtectingEntity(entity, stateIndex, now)) invincibleEnemyCount += 1;
                if ((hittableUntilByEntity.get(entity) || 0) > now) hittableEnemyCount += 1;
                if (detectBotEntity(entity)) botEnemyCount += 1;
            }
        }
        return {
            liveRoots, eligibleRoots, excludedLocalCount, excludedDeadCount,
            nodes, meshes, lodGroups,
            allyCount, enemyCount, unknownCount,
            liveTitleCount, enemyTitleCount,
            liveTitleRootCount, enemyTitleRootCount,
            liveNicknameNodeCount, enemyNicknameNodeCount,
            hittableEnemyCount,
            invincibleEnemyCount,
            botEnemyCount,
        };
    };

    // 读取标题组件原生可见性（新构建 t12a_1，旧构建 n127_1）。
    const readNativeTitleVisible = (owner) => {
        if (!isObject(owner)) return true;
        for (const field of TITLE_VISIBLE_FIELDS) {
            try {
                if (typeof owner[field] === 'boolean') return owner[field];
            } catch (_) {}
        }
        return true;
    };

    // 实体事件分发方法：旧构建 cyw，新构建 iyz（事件总线）。
    // 若该方法已被本脚本包装，则调用其原始实现，避免主动重投事件触发自身拦截逻辑。
    const dispatchEntityEvent = (entity, eventObject) => {
        if (!isObject(entity) || !isObject(eventObject)) return false;
        const invoke = (name) => {
            const fn = entity[name];
            if (typeof fn !== 'function') return false;
            const real = typeof fn.__tankXrayOriginal === 'function' ? fn.__tankXrayOriginal : fn;
            try { real.call(entity, eventObject); return true; } catch (_) { return false; }
        };
        return invoke('iyz') || invoke('cyw');
    };

    // === 实体事件总线拦截：捕获瞄准描边上色事件（新构建 iyz 事件总线，而非原型字段赋值）===
    // QMt 类描边事件：j15s_1=颜色整数、k15s_1=粗细则色位；关闭事件(tDt/new tDt())无颜色载荷。
    // 收到带颜色的事件表示该坦克正被瞄准（可击中）。
    const isOutlineTargetEvent = (eventObject) => {
        if (!isObject(eventObject)) return null;
        // 颜色载荷字段（新构建 j15s_1=颜色整数、k15s_1=粗细则色位）。
        const color = Number(eventObject.j15s_1);
        if (Number.isInteger(color) && color >= 0 && color <= 0xffffff) {
            return { active: true, color };
        }
        // 关闭事件：新构建 new tDt()（描边关闭，无颜色）。按构造器名判定，
        // 避免把无 j15s_1/k15s_1 的普通对象（如标题事件载荷）误判为关闭。
        let ctorName = '';
        try { ctorName = String(eventObject.constructor?.name || ''); } catch (_) {}
        if (ctorName === 'tDt') {
            return { active: false, color: null };
        }
        return null;
    };

    // 识别标题可见性事件（s_t：i12e_1=事件类型2、j12e_1=是否隐藏；旧构建 c12b_1/d12b_1）。
    const readTitleVisibilityEvent = (eventObject) => {
        if (!isObject(eventObject)) return null;
        const type = Number(eventObject.i12e_1 ?? eventObject.c12b_1);
        if (type !== 2) return null;
        const hasNew = 'j12e_1' in eventObject;
        const hasOld = 'd12b_1' in eventObject;
        if (!hasNew && !hasOld) return null;
        const hidden = hasNew ? Boolean(eventObject.j12e_1) : Boolean(eventObject.d12b_1);
        return { hidden };
    };

    const instrumentEntityBus = (entity) => {
        if (!isObject(entity) || entity.__tankXrayBusInstrumented === VERSION) return;
        // 新构建实体事件分发方法为 iyz；旧构建 cyw）
        const methodName = typeof entity.iyz === 'function' ? 'iyz'
            : (typeof entity.cyw === 'function' ? 'cyw' : null);
        if (!methodName) return;
        const original = entity[methodName];
        try {
            const wrapped = function tankXrayEventBusInterceptor(eventObject) {
                try {
                    // 1) 瞄准/描边上色事件——可击中信号。伤害/治疗同为 QMt(颜色,粗细) 事件：
                    //    落在敌方总线=可击中（橙/红）；落在队友总线=被治疗（绿），需透出原生治疗描边。
                    const verdict = isOutlineTargetEvent(eventObject);
                    if (verdict) {
                        targetBusEvents += 1;
                        const isAlly = (teamByEntity.get(entity) || TEAM_UNKNOWN) === TEAM_ALLY;
                        if (verdict.active) {
                            const until = Date.now() + HITTABLE_SIGNAL_TTL_MS;
                            if (isAlly) {
                                healingUntilByEntity.set(entity, until); // 被治疗的队友：透出绿色原生描边
                            } else {
                                hittableUntilByEntity.set(entity, until);
                            }
                        } else {
                            hittableUntilByEntity.delete(entity);
                            healingUntilByEntity.delete(entity); // 治疗结束（关闭事件）：恢复普通队友蓝
                        }
                        schedulePublish('target-bus-event');
                    }
                    // 2) 标题可见性事件——对敌方且透视开启时阻止隐藏（强制显示）。
                    const titleEvent = readTitleVisibilityEvent(eventObject);
                    if (titleEvent && titleEvent.hidden) {
                        // 总线 entity 即坦克实体（jyw()）。敌我关系在 captureTeamAssignment
                        // 时已写入 teamByEntity；只有敌方、已建立关联且不在排除名单时才改写的?
                        const team = teamByEntity.get(entity) || TEAM_UNKNOWN;
                        const related = rootsByEntity.get(entity);
                        let eligible = false;
                        if (related) {
                            for (const rec of related) { if (isXrayEligible(rec)) { eligible = true; break; } }
                        }
                        if (active && idEnabled && team === TEAM_ENEMY && eligible) {
                            enemyTitleOverrideEvents += 1;
                            // 强制显示：把“隐藏”事件改写为“显示”。
                            if ('j12e_1' in eventObject) eventObject.j12e_1 = false;
                            if ('d12b_1' in eventObject) eventObject.d12b_1 = false;
                        }
                    }
                } catch (_) {}
                return original.call(this, eventObject);
            };
            wrapped.__tankXrayOriginal = original;
            Object.defineProperty(entity, methodName, {
                configurable: true,
                enumerable: false,
                writable: true,
                value: wrapped,
            });
            entity.__tankXrayBusInstrumented = VERSION;
            instrumentedEntityBusCount += 1;
        } catch (error) {
            hookErrors.push({ stage: 'entity-bus-instrument', field: methodName, message: String(error?.message || error) });
        }
    };

    const dispatchEnemyTitleVisibility = (forceVisible) => {
        pendingTitleVisibility = null;
        // 构造可见性事件：优先用捕获到的原生构造器；否则使用兼容载荷。
        // （新构建 s_t：i12e_1=2/j12e_1=hidden，旧构建 t_t：c12b_1=2/d12b_1=hidden）。
        const buildEvent = (hidden) => {
            if (typeof titleVisibilityEventConstructor === 'function') {
                try { return new titleVisibilityEventConstructor(2, hidden); } catch (_) {}
            }
            return { i12e_1: 2, j12e_1: hidden, c12b_1: 2, d12b_1: hidden };
        };
        let dispatched = 0;
        for (const record of titleRecords) {
            const owner = record.ownerRef.deref();
            if (!owner) continue;
            const eligibleEnemy = record.team === TEAM_ENEMY && isXrayEligible(record);
            // 关闭透视：仅对曾被强制显示的标题补发“恢复原生可见性”事件，并清除标志。
            if (!forceVisible) {
                if (record.xrayForcedShown) {
                    const entity = record.entityRef?.deref?.() || safeEntityFromOwner(owner);
                    const nativeVisible = readNativeTitleVisible(owner);
                    if (entity && !nativeVisible) {
                        try {
                            const eventObject = buildEvent(true);
                            if (dispatchEntityEvent(entity, eventObject)) dispatched += 1;
                        } catch (_) {}
                    }
                }
                record.xrayForcedShown = false;
                continue;
            }
            // 打开透视/周期重扫：对合格敌方标题补发显示事件。
            // 不再“只发一次”——首次补发若时机太早/被游戏吞掉，之后游戏按距离/复活再次隐藏时名字会永久丢失。
            // 改为：新标题立即发；已发过的，若原生可见性当前为“隐藏”且距上次补发超过 TITLE_RESEND_MS，则重发（节流避免刷屏）。
            if (!eligibleEnemy) continue;
            const entity = record.entityRef?.deref?.() || safeEntityFromOwner(owner);
            if (!entity) continue;
            // 兜底：确保实体事件总线已插桩（标题根路径可能漏掉）。
            instrumentEntityBus(entity);
            const nowTs = Date.now();
            const alreadyShown = record.xrayForcedShown && (nowTs - (record.lastForceShowAt || 0) < TITLE_RESEND_MS);
            if (alreadyShown) continue;
            // 已经稳定显示（原生可见性为 true）的无需重发；读不到可见性时按需要补发，保证不漏。
            const nativeVisible = readNativeTitleVisible(owner);
            if (record.xrayForcedShown && nativeVisible) { record.lastForceShowAt = nowTs; continue; }
            try {
                const eventObject = buildEvent(false);
                if (dispatchEntityEvent(entity, eventObject)) {
                    dispatched += 1;
                    record.xrayForcedShown = true;
                    record.lastForceShowAt = nowTs;
                }
            } catch (_) {}
        }
        titleVisibilityDispatches += dispatched;
        return dispatched;
    };

    const statusFor = (snapshot) => {
        if (!active || !enabled) return '透视已关闭，游戏原始轮廓状态已恢复';
        if (snapshot.targetCount <= 0) {
            if (snapshot.totalLiveRootCount > 0) {
                return `精细轮廓已启动 · 当前模型均已排除（自身 ${snapshot.excludedLocalCount} / 残骸 ${snapshot.excludedDeadCount}）`;
            }
            return '精细轮廓已启动，正在等待坦克模型生成';
        }
        const teamText = `敌 ${snapshot.enemyCount} · 友 ${snapshot.allyCount}`;
        const hitText = snapshot.hittableEnemyCount > 0 ? ` · 可击中橙色 ${snapshot.hittableEnemyCount}` : '';
        const excludedText = (snapshot.excludedLocalCount + snapshot.excludedDeadCount) > 0
            ? ` · 已排除自身 ${snapshot.excludedLocalCount} / 残骸 ${snapshot.excludedDeadCount}`
            : '';
        return `精细轮廓已接管 ${snapshot.targetCount} 辆坦克（${teamText}${hitText}${excludedText}）`;
    };

    const buildState = (reason = lastReason) => {
        const scan = scanRoots();
        // 新旧构建字段名并存：只要求至少一个坦克皮肤根 hook 安装成功。
        const available = installedRootHookCount > 0;
        const teamColorsAvailable = teamRelationHookInstalled && trackedAssociationHookInstalled;
        // 昵称牌穿墙依赖：敌我关系 + 标题根 + 标题可见性。
        // 渲染阶段 16～17（无深度）是核心，由标题根 hook + instrumentTitleTree 保证；
        // 新构建可见性事件走事件总线（不经过原型赋值），旧构建经 d12b_1 赋值。
        const distantEnemyIdsAvailable = teamRelationHookInstalled
            && titleRootHookInstalled
            && (titleStateHookInstalled || titleEventHookInstalled);
        const stateEnabled = available && active && enabled;
        const snapshot = {
            version: VERSION,
            adapterName: ADAPTER_NAME,
            available,
            enabled: stateEnabled,
            allyOutlineEnabled: active && allyOutlineEnabled,
            targetCount: scan.eligibleRoots,
            totalLiveRootCount: scan.liveRoots,
            excludedLocalCount: scan.excludedLocalCount,
            excludedDeadCount: scan.excludedDeadCount,
            outlineStyle: 'thin',
            nodeCount: scan.nodes,
            meshCount: scan.meshes,
            lodCount: scan.lodGroups,
            allyCount: scan.allyCount,
            enemyCount: scan.enemyCount,
            unknownCount: scan.unknownCount,
            titleCount: scan.liveTitleCount,
            enemyTitleCount: scan.enemyTitleCount,
            titleRootCount: scan.liveTitleRootCount,
            enemyTitleRootCount: scan.enemyTitleRootCount,
            nicknameNodeCount: scan.liveNicknameNodeCount,
            enemyNicknameNodeCount: scan.enemyNicknameNodeCount,
            hittableEnemyCount: scan.hittableEnemyCount,
            invincibleEnemyCount: scan.invincibleEnemyCount,
            botEnemyCount: scan.botEnemyCount,
            allyColor,
            enemyColor,
            hittableColor,
            invincibleColor,
            botColor,
            teamColorsAvailable,
            distantEnemyIdsAvailable,
            idXrayAvailable: distantEnemyIdsAvailable,
            idEnabled: distantEnemyIdsAvailable && active && idEnabled,
            nativeStages: ['OutlineStencil', 'Outline'],
            depthTestDisabledInOutlineStage: true,
            rootFields: ROOT_FIELD_SPECS.map((spec) => spec.field),
            titleRootFields: [...TITLE_ROOT_FIELDS],
            teamRelationFields: [...TEAM_RELATION_FIELDS],
            nicknameFields: [...NICKNAME_FIELDS],
            titleVisibleFields: [...TITLE_VISIBLE_FIELDS],
            hookStatus: {
                installedRootHookCount,
                rootHookTotal: ROOT_FIELD_SPECS.length,
                teamRelationHookCount,
                nicknameHookCount,
                trackedAssociationHookCount,
                titleRootHookCount,
                nicknameNodeHookCount,
                titleStateHookCount,
                titleEventHookInstalled,
            },
            capturedRootCount,
            rootAssignments,
            instrumentedNodeCount,
            instrumentedMeshCount,
            instrumentedLodCount,
            overrideReads,
            fieldAssignments,
            teamAssignments,
            enemyTitleOverrideEvents,
            titleVisibilityDispatches,
            targetVisualEvents,
            targetBusEvents,
            instrumentedEntityBusCount,
            changedAt,
            reason,
            hookErrors: hookErrors.map((item) => ({ ...item })),
            error: available ? '' : '坦克根节点捕获钩子未完整安装',
        };
        snapshot.status = statusFor(snapshot);
        return snapshot;
    };

    const publishState = (reason = lastReason, requestId = null, force = false) => {
        const snapshot = buildState(reason);
        // ID 透视开启期间，周期重扫/状态变化时对“新出现且尚未强制显示”的敌方昵称牌补发显示事件，
        // 这样运行中刷新出来的敌人无需手动关开一次开关即可强制显示名称。
        if (active && idEnabled && snapshot.enemyTitleCount > 0) {
            try { dispatchEnemyTitleVisibility(true); } catch (_) {}
        }
        const signature = [snapshot.enabled, snapshot.allyOutlineEnabled, snapshot.available, snapshot.targetCount, snapshot.nodeCount,
            snapshot.meshCount, snapshot.enemyCount, snapshot.allyCount, snapshot.unknownCount,
            snapshot.hittableEnemyCount, snapshot.idEnabled, snapshot.enemyTitleCount,
            snapshot.excludedLocalCount, snapshot.excludedDeadCount,
            snapshot.error].join('|');
        if (!force && signature === lastPublishedSignature) return snapshot;
        lastPublishedSignature = signature;
        try {
            page.dispatchEvent(new CustomEvent(STATE_EVENT, {
                detail: {
                    ...snapshot,
                    ...(requestId == null ? {} : { requestId }),
                },
            }));
        } catch (_) {}
        return snapshot;
    };

    function schedulePublish(reason = lastReason) {
        lastReason = reason;
        if (publishTimer != null) return;
        publishTimer = page.setTimeout(() => {
            publishTimer = null;
            publishState(reason);
        }, 0);
    }

    const stopRescan = () => {
        if (rescanTimer != null) page.clearInterval(rescanTimer);
        rescanTimer = null;
    };

    const startRescan = () => {
        if (rescanTimer != null || !active || (!enabled && !idEnabled)) return;
        rescanTimer = page.setInterval(() => publishState('periodic-rescan'), RESCAN_INTERVAL_MS);
    };

    const setEnabled = (nextEnabled, context = {}) => {
        enabled = Boolean(nextEnabled);
        active = true;
        changedAt = Date.now();
        lastReason = String(context.reason || (enabled ? 'enable' : 'disable'));
        if (enabled) {
            startRescan();
        } else {
            if (!idEnabled) stopRescan();
        }
        return publishState(lastReason, context.requestId, true);
    };

    const setIdEnabled = (nextEnabled, context = {}) => {
        idEnabled = Boolean(nextEnabled);
        active = true;
        changedAt = Date.now();
        lastReason = String(context.reason || (idEnabled ? 'enable-id-xray' : 'disable-id-xray'));
        if (idEnabled) {
            startRescan();
            // 已经被距离规则隐藏的敌方标题，补发一次游戏原生显示事件。
            page.setTimeout(() => {
                if (active && idEnabled) dispatchEnemyTitleVisibility(true);
            }, 0);
        } else {
            // 恢复标题控制器保存的原生最远距离可见状态，并清除“已强制显示”标志。
            try { dispatchEnemyTitleVisibility(false); } catch (_) {}
            if (!enabled) stopRescan();
        }
        return publishState(lastReason, context.requestId, true);
    };


    const setAllyOutlineEnabled = (nextEnabled, context = {}) => {
        allyOutlineEnabled = Boolean(nextEnabled);
        active = true;
        changedAt = Date.now();
        lastReason = String(context.reason
            || (allyOutlineEnabled ? 'enable-ally-outline' : 'disable-ally-outline'));
        // 轮廓状态由渲染器每帧读取访问器，无需重扫；强制广播一次让 UI 刷新。
        return publishState(lastReason, context.requestId, true);
    };

    const onTargetVisualState = (event) => {
        const detail = event?.detail;
        const entity = detail?.entity;
        if (!isObject(entity)) return;
        targetVisualEvents += 1;
        if (detail.damaging === true && detail.active !== false) {
            hittableUntilByEntity.set(entity, Date.now() + HITTABLE_SIGNAL_TTL_MS);
        } else {
            hittableUntilByEntity.delete(entity);
        }
        schedulePublish('native-target-state');
    };
    page.addEventListener(TARGET_VISUAL_EVENT, onTargetVisualState);

    const onRequest = (event) => {
        const detail = event?.detail;
        if (!detail || typeof detail !== 'object') return;
        let result;
        if (typeof detail.allyOutline === 'boolean') {
            result = setAllyOutlineEnabled(detail.allyOutline, detail);
        } else {
            result = setEnabled(detail.enabled, detail);
        }
        try { detail.respond?.(result); } catch (_) {}
    };
    page.addEventListener(REQUEST_EVENT, onRequest);

    const runtime = {
        version: VERSION,
        adapterName: ADAPTER_NAME,
        setPersistentEnabled: setEnabled,
        setEnabled,
        setIdEnabled,
        setAllyOutlineEnabled,
        enableIds: (context = {}) => setIdEnabled(true, context),
        disableIds: (context = {}) => setIdEnabled(false, context),
        enable: (context = {}) => setEnabled(true, context),
        disable: (context = {}) => setEnabled(false, context),
        enableAllyOutline: (context = {}) => setAllyOutlineEnabled(true, context),
        disableAllyOutline: (context = {}) => setAllyOutlineEnabled(false, context),
        isEnabled: () => active && enabled,
        isIdEnabled: () => active && idEnabled,
        isAllyOutlineEnabled: () => active && allyOutlineEnabled,
        getState: () => buildState('get-state'),
        getDiagnostics: () => buildState('diagnostics'),
        setColor(value, reason = 'set-color') {
            const next = Number(value);
            if (!Number.isInteger(next) || next < 0 || next > 0xffffff) {
                throw new RangeError('轮廓颜色必须为 0x000000～0xFFFFFF 的整数');
            }
            enemyColor = next;
            changedAt = Date.now();
            lastReason = reason;
            return publishState(reason, null, true);
        },
        setTeamColors(colors = {}, reason = 'set-team-colors') {
            const nextAlly = colors.ally == null ? allyColor : Number(colors.ally);
            const nextEnemy = colors.enemy == null ? enemyColor : Number(colors.enemy);
            const nextHittable = colors.hittable == null ? hittableColor : Number(colors.hittable);
            const nextInvincible = colors.invincible == null ? invincibleColor : Number(colors.invincible);
            const nextBot = colors.bot == null ? botColor : Number(colors.bot);
            for (const [name, value] of [
                ['ally', nextAlly], ['enemy', nextEnemy], ['hittable', nextHittable],
                ['invincible', nextInvincible], ['bot', nextBot],
            ]) {
                if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
                    throw new RangeError(`${name} 轮廓颜色必须为 0x000000～0xFFFFFF 的整数`);
                }
            }
            allyColor = nextAlly;
            enemyColor = nextEnemy;
            hittableColor = nextHittable;
            invincibleColor = nextInvincible;
            botColor = nextBot;
            changedAt = Date.now();
            lastReason = reason;
            return publishState(reason, null, true);
        },
        resume(reason = 'resume') {
            active = true;
            changedAt = Date.now();
            lastReason = reason;
            if (enabled || idEnabled) {
                startRescan();
            }
            if (idEnabled) {
                page.setTimeout(() => {
                    if (active && idEnabled) dispatchEnemyTitleVisibility(true);
                }, 0);
            }
            return publishState(reason, null, true);
        },
        suspend(reason = 'suspend') {
            active = false;
            stopRescan();
            dispatchEnemyTitleVisibility(false);
            changedAt = Date.now();
            lastReason = reason;
            return publishState(reason, null, true);
        },
    };

    Object.defineProperty(page, GLOBAL_NAME, {
        configurable: true,
        enumerable: false,
        writable: false,
        value: runtime,
    });
})();

(function installNativeTargetVisualBridge() {
    'use strict';

    const page = window;
    const GLOBAL_NAME = '__StandaloneXrayTargetBridge';
    const VERSION = '1.0.0';
    const TARGET_ENTITY_FIELD = 'k198_1';
    const TARGET_HIGHLIGHT_FIELD = 'h19b_1';
    const TARGET_VISUAL_EVENT = 'tank-assistant-suite:native-target-state';
    const previous = page[GLOBAL_NAME];
    if (previous?.version === VERSION) return;

    const entityByTarget = new WeakMap();
    const highlightByTarget = new WeakMap();
    const errors = [];
    let entityEvents = 0;
    let highlightEvents = 0;
    let visualEvents = 0;

    const isObject = (value) => value != null && (typeof value === 'object' || typeof value === 'function');
    const classify = (value) => {
        if (value == null || value === false) return { active: false, damaging: false, kind: 'NONE' };
        if (value === true) return { active: true, damaging: true, kind: 'BOOLEAN_DAMAGING' };
        let text = '';
        try { text = String(value).toUpperCase(); } catch (_) {}
        if (text.includes('TARGETING_DAMAGING')) return { active: true, damaging: true, kind: 'TARGETING_DAMAGING' };
        if (text.includes('TARGETING_HEALING')) return { active: true, damaging: false, kind: 'TARGETING_HEALING' };
        if (text === 'RADAR' || text.includes('TARGETING_RADAR')) return { active: true, damaging: false, kind: 'RADAR' };
        const index = Number(value?.k3_1);
        if (index === 0) return { active: true, damaging: true, kind: 'ENUM_0_DAMAGING' };
        if (index === 1) return { active: true, damaging: false, kind: 'ENUM_1_HEALING' };
        if (index === 2) return { active: true, damaging: false, kind: 'ENUM_2_RADAR' };
        return { active: false, damaging: false, kind: 'UNKNOWN' };
    };

    const dispatch = (entity, rawValue, forcedInactive = false) => {
        if (!isObject(entity)) return;
        const classification = forcedInactive
            ? { active: false, damaging: false, kind: 'ENTITY_REPLACED' }
            : classify(rawValue);
        try {
            page.dispatchEvent(new CustomEvent(TARGET_VISUAL_EVENT, {
                detail: {
                    entity,
                    active: classification.active,
                    damaging: classification.damaging,
                    kind: classification.kind,
                    rawValue,
                    at: Date.now(),
                },
            }));
            visualEvents += 1;
        } catch (error) {
            errors.push({ stage: 'dispatch', message: String(error?.message || error) });
        }
    };

    const publish = (target) => {
        if (!isObject(target)) return;
        dispatch(entityByTarget.get(target), highlightByTarget.get(target));
    };

    const onAssignment = (role, target, value, previousValue) => {
        if (!isObject(target)) return;
        if (role === 'entity') {
            entityEvents += 1;
            const previousEntity = entityByTarget.get(target);
            if (previousEntity && previousEntity !== value) dispatch(previousEntity, null, true);
            if (isObject(value)) entityByTarget.set(target, value);
            else entityByTarget.delete(target);
            publish(target);
            return;
        }
        highlightEvents += 1;
        highlightByTarget.set(target, value);
        publish(target);
        if (previousValue != null && value == null) dispatch(entityByTarget.get(target), null, true);
    };

    const installFieldHook = (field, role) => {
        const existing = Object.getOwnPropertyDescriptor(Object.prototype, field);
        if (existing) {
            errors.push({ stage: 'install', field, message: 'Object.prototype 已存在同名字段，未覆盖' });
            return false;
        }
        const setter = function standaloneXrayTargetFieldCapture(initialValue) {
            let storedValue = initialValue;
            try {
                Object.defineProperty(this, field, {
                    configurable: true,
                    enumerable: true,
                    get() { return storedValue; },
                    set(nextValue) {
                        const previousValue = storedValue;
                        storedValue = nextValue;
                        onAssignment(role, this, nextValue, previousValue);
                    },
                });
                onAssignment(role, this, initialValue, undefined);
            } catch (error) {
                errors.push({ stage: 'instance', field, message: String(error?.message || error) });
            }
        };
        Object.defineProperty(setter, '__standaloneXrayTargetHook', { value: VERSION });
        try {
            Object.defineProperty(Object.prototype, field, {
                configurable: true,
                enumerable: false,
                get: undefined,
                set: setter,
            });
            return true;
        } catch (error) {
            errors.push({ stage: 'install', field, message: String(error?.message || error) });
            return false;
        }
    };

    const installedEntityHook = false;
    const installedHighlightHook = false;
    const api = Object.freeze({
        version: VERSION,
        targetEntityField: TARGET_ENTITY_FIELD,
        targetHighlightField: TARGET_HIGHLIGHT_FIELD,
        available: installedEntityHook && installedHighlightHook,
        classify,
        getDiagnostics: () => ({
            version: VERSION,
            available: installedEntityHook && installedHighlightHook,
            entityEvents,
            highlightEvents,
            visualEvents,
            errors: errors.map((item) => ({ ...item })),
        }),
    });
    Object.defineProperty(page, GLOBAL_NAME, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: api,
    });
})();

(function installStandaloneXrayControlPanel() {
    'use strict';

    const page = window;
    const doc = document;
    const HOST_ID = 'standalone-tank-xray-panel';
    const STORAGE_KEY = 'standalone_tank_xray_settings_v1';
    const STATE_EVENT = 'tank-assistant-suite:xray-state';

    /* ============================================================
     * 名称授权白名单（唯一需要你自己改的地方）
     * ------------------------------------------------------------
     * 只有「大厅玩家名称」出现在下表里的账号，加载动画结束后才会
     * 通过名称校验：校验通过后才能按 Insert / - 呼出主悬浮窗、
     * 使用透视功能；名称不在表里的人，脚本功能一律不启用、
     * 主悬浮窗也无法呼出（把脚本转发给别人同样如此）。
     *
     * 用法：把要授权的玩家名称原样填进下面的引号里，多个用逗号隔开。
     *   const AUTHORIZED_NAMES = ['你的名称', '朋友A的名称', '朋友B的名称'];
     * 不区分大小写、忽略首尾空格；其余字符必须与游戏内名称完全一致。
     * ============================================================ */
    const AUTHORIZED_NAMES = [
        'C-C-T-V-3',
        'Trklink1917',
        'Vacher_Const',
        'Cute',
        'EIaina',
        'dabaozuibang',
        'Nikonikoni',
    ];
    const cleanName = (value) => String(value == null ? '' : value).trim();
    const normalizeName = (value) => cleanName(value).toLowerCase();
    const AUTHORIZED_SET = new Set(
        AUTHORIZED_NAMES.map((name) => normalizeName(name)).filter(Boolean)
    );
    // 从大厅顶栏读取本机玩家名称：
    // <span class="UserInfoContainerStyle-userNameRank UserInfoContainerStyle-textDecoration">名称</span>
    // 从 "[军团名]玩家名" 里只取玩家名：截掉最后一个 ] 】 ) 之前的内容。
    const extractPlayerName = (rawText) => {
        if (rawText == null) return '';
        let text = String(rawText).replace(/\u00a0/g, ' ').trim();
        if (!text) return '';
        const lastBracket = Math.max(
            text.lastIndexOf(']'),
            text.lastIndexOf('】'),
            text.lastIndexOf(')'),
        );
        if (lastBracket >= 0) text = text.slice(lastBracket + 1).trim();
        return text;
    };
    const readLobbyPlayerName = () => {
        try {
            const span = doc.querySelector(
                '[class*="UserInfoContainerStyle-userNameRank"]'
            );
            if (span) {
                const name = cleanName(extractPlayerName(span.textContent));
                if (name) return { name, source: 'lobby' };
            }
        } catch (_) {}
        // 兜底：部分构建类名前缀不同，扫描含 userNameRank 的节点
        try {
            const all = doc.querySelectorAll('span');
            for (let i = 0; i < all.length; i += 1) {
                const cls = all[i].className || '';
                if (typeof cls === 'string'
                    && /UserInfoContainerStyle-userNameRank/.test(cls)) {
                    const name = cleanName(extractPlayerName(all[i].textContent));
                    if (name) return { name, source: 'lobby-fallback' };
                }
            }
        } catch (_) {}
        return { name: '', source: '' };
    };
    const isNameAuthorized = (name) => AUTHORIZED_SET.has(normalizeName(name));

    const DEFAULTS = Object.freeze({
        outline: false,
        allyOutline: true,
        ids: false,
        enemy: '#ff6666',
        ally: '#33bbff',
        hittable: '#ff9800',
        invincible: '#ffffff',
        bot: '#ff00ff',
        hidden: false,
        pos: null,
        // 战场功能·道具三开
        threeEnabled: false,   // 三开总开关
        threeHotkey: '9',      // 三开切换热键
        threeInterval: 50,     // 道具内核触发间隔 ms（固定触发：护甲 / 伤害 / 加速；范围 10–50）
        // 战场功能·地雷（键盘模拟，提取自特技脚本）
        mineEnabled: false,    // 地雷总开关
        mineHotkey: 'F4',      // 地雷切换热键
        mineInterval: 23,      // 模拟 5 键（投放地雷）的间隔 ms，原特技脚本固定 23
        activePage: 'home',    // 侧栏最后停留的页签
    });

    const runtime = page.__TankXrayDebugRuntime;
    if (!runtime) {
        console.error('[StandaloneXray] 战术透视早期运行时未安装');
        return;
    }

    const normalizeColor = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value || ''))
        ? String(value).toLowerCase()
        : fallback;
    const readSettings = () => {
        let saved = {};
        try { saved = JSON.parse(page.localStorage.getItem(STORAGE_KEY) || '{}'); } catch (_) {}
        return {
            outline: saved.outline === true,
            allyOutline: saved.allyOutline !== false,
            ids: saved.ids === true,
            enemy: normalizeColor(saved.enemy, DEFAULTS.enemy),
            ally: normalizeColor(saved.ally, DEFAULTS.ally),
            hittable: normalizeColor(saved.hittable, DEFAULTS.hittable),
            invincible: normalizeColor(saved.invincible, DEFAULTS.invincible),
            bot: normalizeColor(saved.bot, DEFAULTS.bot),
            hidden: saved.hidden === true,
            pos: (saved.pos && Number.isFinite(saved.pos.left) && Number.isFinite(saved.pos.top))
                ? { left: saved.pos.left, top: saved.pos.top }
                : null,
            threeEnabled: saved.threeEnabled === true,
            threeHotkey: (typeof saved.threeHotkey === 'string' && saved.threeHotkey)
                ? saved.threeHotkey.slice(0, 12) : DEFAULTS.threeHotkey,
            threeInterval: Number.isFinite(saved.threeInterval) && saved.threeInterval >= 50
                ? Math.min(100, Math.max(50, Math.round(saved.threeInterval))) : DEFAULTS.threeInterval,
            mineEnabled: saved.mineEnabled === true,
            mineHotkey: (typeof saved.mineHotkey === 'string')
                ? saved.mineHotkey.slice(0, 12) : DEFAULTS.mineHotkey,
            mineInterval: Number.isFinite(saved.mineInterval) && saved.mineInterval >= 20
                ? Math.min(50, Math.max(20, Math.round(saved.mineInterval))) : DEFAULTS.mineInterval,
            activePage: ['home', 'join', 'battle', 'xray', 'about'].includes(saved.activePage)
                ? saved.activePage : DEFAULTS.activePage,
        };
    };
    const settings = readSettings();
    const save = () => {
        try { page.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
    };
    const colorNumber = (hex) => Number.parseInt(hex.slice(1), 16);
    const applyColors = () => runtime.setTeamColors({
        enemy: colorNumber(settings.enemy),
        ally: colorNumber(settings.ally),
        hittable: colorNumber(settings.hittable),
        invincible: colorNumber(settings.invincible),
        bot: colorNumber(settings.bot),
    }, 'standalone-color-settings');

    applyColors();
    // 名称授权通过前，不启用任何透视运行时功能（轮廓/队友轮廓/ID 全关）；
    // 授权通过后由 unlockFeatures() 按本地保存的设置恢复。
    runtime.setEnabled(false, { reason: 'standalone-await-name-auth' });
    runtime.setAllyOutlineEnabled(false, { reason: 'standalone-await-name-auth' });
    runtime.setIdEnabled(false, { reason: 'standalone-await-name-auth' });

    /* ============================================================
     * 战场功能·道具三开（内核触发，提取自独立三开脚本）
     * 扫描 React 状态树 -> Root/World/LocalTank -> 道具函数表，
     * Worker 定时直接调用内核函数使用 护甲 / 伤害 / 速度。
     * 同样受名称授权门控：未通过白名单校验绝不触发。
     * ============================================================ */
    const threeCheats = { Root: undefined, World: undefined, LocalTank: undefined };
    const threeKernelBase = {
        ReactContainer: undefined,
        Root: { Key1: undefined, Key2: undefined },
        _TOState: { Key1: undefined },
        TOState: {},
        isGameReady: { isReady: undefined, isReadyKey: undefined },
        World: { Key1: undefined, Key2: undefined, Key3: undefined, Key4: undefined, Key5: undefined },
        LocalTank: { Key1: undefined, Key2: undefined },
    };
    const TankKernel = {
        base: threeKernelBase,
        simpleName(x) {
            const m = {};
            if (!x || x === false) return m;
            for (const D in x) {
                try {
                    const W = x[D].toString().match(/^\w+/);
                    if (W) m[W[0]] = x[D];
                } catch (X) {}
            }
            return m;
        },
        stateNode2() {
            const x = doc.getElementById('app-root');
            if (!x) return null;
            if (this.base.ReactContainer) return x[this.base.ReactContainer];
            for (const m in x) {
                if (m.startsWith('__reactContainer$')) { this.base.ReactContainer = m; return x[m]; }
            }
            return null;
        },
        getReactStateNode() {
            try {
                const x = this.stateNode2();
                if (this.base.Root.Key1 && this.base.Root.Key2) {
                    return x && x.child && x.child.child && x.child.child.stateNode
                        && x.child.child.stateNode[this.base.Root.Key1]
                        && x.child.child.stateNode[this.base.Root.Key1][this.base.Root.Key2];
                }
                const m = x && x.child && x.child.child && x.child.child.stateNode;
                if (!m) return;
                const D = Object.keys(m);
                this.base.Root.Key1 = D[5];
                this.base.Root.Key2 = Object.keys(m[this.base.Root.Key1])[2];
                this.base._TOState.Key1 = Object.keys(m[this.base.Root.Key1][this.base.Root.Key2])[4];
                threeCheats.Root = m[this.base.Root.Key1][this.base.Root.Key2];
                return threeCheats.Root;
            } catch (W) { return undefined; }
        },
        findIsGameReady() {
            const x = this.getReactStateNode();
            if (this.base._TOState.Key1 && !this.base.isGameReady.isReadyKey) {
                const m = x && x[this.base._TOState.Key1];
                for (const D in m) {
                    try {
                        if (m[D] && m[D].toString().startsWith('BattleStatistics')) {
                            this.base.TOState.BattleStatistics = D;
                        }
                    } catch (W) {}
                }
                this.base.isGameReady.isReadyKey = Object.keys(
                    (x && x[this.base._TOState.Key1] && x[this.base._TOState.Key1][this.base.TOState.BattleStatistics]) || {}
                )[20];
            }
            if (this.base.isGameReady.isReadyKey) {
                this.base.isGameReady.isReady
                    = x && x[this.base._TOState.Key1]
                    && x[this.base._TOState.Key1][this.base.TOState.BattleStatistics]
                    && x[this.base._TOState.Key1][this.base.TOState.BattleStatistics][this.base.isGameReady.isReadyKey];
                return this.base.isGameReady.isReady;
            }
            return false;
        },
        tick() {
            if (!this.findIsGameReady()) return;
            const x = threeCheats.Root;
            if (!x) return;
            try {
                if (!this.base.World.Key1) {
                    this.base.World.Key1 = Object.keys(x)[1];
                    this.base.World.Key2 = Object.keys(x[this.base.World.Key1])[1];
                }
                const m = x[this.base.World.Key1] && x[this.base.World.Key1][this.base.World.Key2];
                if (!m) return;
                const D = Object.entries(m).findLast(([, W]) =>
                    Object.keys(W || {}).length === 3 && typeof Object.values(W)[2] === 'boolean');
                if (D) {
                    this.base.World.Key3 = D[1];
                    this.base.World.Key4 = Object.keys(this.base.World.Key3)[0];
                    this.base.World.Key5 = Object.keys(this.base.World.Key3[this.base.World.Key4])[1];
                    threeCheats.World = this.base.World.Key3[this.base.World.Key4][this.base.World.Key5];
                    const W = this.base.World.Key3[this.base.World.Key4];
                    this.base.LocalTank.Key1 = Object.keys(W)[7];
                    this.base.LocalTank.Key2 = W[this.base.LocalTank.Key1]
                        ? Object.keys(W[this.base.LocalTank.Key1])[0] : undefined;
                    threeCheats.LocalTank = W[this.base.LocalTank.Key1]
                        && W[this.base.LocalTank.Key1][this.base.LocalTank.Key2];
                }
                this.findSupplies();
            } catch (X) {}
        },
        findSupplies() {
            try {
                if (!this.findIsGameReady()) return;
                const x = Object.entries(threeCheats.LocalTank || {}).findLast(([, U]) =>
                    Object.keys(U).length >= 30 && this.simpleName(U).TankInfoCC);
                if (!x) return;
                const m = threeCheats.LocalTank[x[0]];
                const D = m[Object.keys(m)[9]][Object.keys(m[Object.keys(m)[9]])[5]];
                const W = {};
                const X = D[Object.keys(D)[0]];
                const V = D[Object.keys(D)[1]];
                for (let U = 0; U < X.length; U++) {
                    if (!X[U] || !V[U]) continue;
                    const Q = X[U][Object.keys(X[U])[0]];
                    const Z = V[U][Object.keys(V[U])[0]];
                    W[Q] = Z;
                }
                threeCheats.getSupplies = W;
            } catch (M) {}
        },
    };
    page.setInterval(() => TankKernel.tick(), 100);

    // Worker 定时心跳（时间轴独立于页面渲染，避免卡顿导致道具断档）
    const threeWorkerSrc = [
        'const timers = {};',
        'self.onmessage = function(e) {',
        '  const d = e.data;',
        "  if (d.type === 'start' || d.type === 'update') {",
        '    if (timers[d.supply]) clearInterval(timers[d.supply]);',
        "    timers[d.supply] = setInterval(() => self.postMessage({ supply: d.supply }), Math.max(d.ms > 0 ? d.ms : 100, 50));",
        "  } else if (d.type === 'stop') { clearInterval(timers[d.supply]); delete timers[d.supply]; }",
        '};',
    ].join('\n');
    let threeWorker = null;
    try {
        threeWorker = new Worker(URL.createObjectURL(new Blob([threeWorkerSrc], { type: 'application/javascript' })));
    } catch (_) { threeWorker = null; }
    const THREE_AUTO_SUPPLIES = ['DOUBLE_ARMOR', 'DOUBLE_DAMAGE', 'NITRO'];
    if (threeWorker) {
        threeWorker.onmessage = (ev) => {
            // 双重门控：本地开关 + 名称白名单授权通过
            if (!settings.threeEnabled || !nameAuthPassed) return;
            const caller = threeCheats.getSupplies && threeCheats.getSupplies[ev.data.supply];
            if (typeof caller !== 'function') return;
            try { caller(); } catch (_) {}
        };
        THREE_AUTO_SUPPLIES.forEach((supply) => {
            threeWorker.postMessage({ type: 'start', supply, ms: settings.threeInterval });
        });
    }
    const threeRefreshTimers = () => {
        if (!threeWorker) return;
        THREE_AUTO_SUPPLIES.forEach((supply) => {
            threeWorker.postMessage({ type: 'update', supply, ms: settings.threeInterval });
        });
    };
    const isChatFocused = () => !!doc.querySelector('.InputComponentStyle-input')
        || !!doc.querySelector('.ChatComponentStyle-chatWindow');
    const threeToast = () => {};
    const renderThreeUI = () => {
        const host = doc.getElementById(HOST_ID);
        if (!host || !host.shadowRoot) return;
        const btn = host.shadowRoot.getElementById('three-toggle');
        if (btn) {
            btn.textContent = '[' + (settings.threeHotkey || '无') + '] 三开 · ' + (settings.threeEnabled ? '运行中' : '已停止');
            btn.classList.toggle('run', settings.threeEnabled);
        }
    };
    const setThreeEnabled = (on) => {
        if (isChatFocused()) return;
        settings.threeEnabled = !!on;
        save();
        renderThreeUI();
        threeToast(settings.threeEnabled ? '三开开启（内核触发）' : '三开关闭');
    };
    const toggleThree = () => setThreeEnabled(!settings.threeEnabled);

    /* ============================================================
     * 战场功能·自动地雷（键盘模拟，提取自特技脚本 setMinesAutomation）
     * 定时向 document.body 派发 5 键 keydown/keyup（Digit5/keyCode 53），
     * 等价于在游戏里狂按地雷键。受名称授权门控：未通过白名单不触发。
     * ============================================================ */
    let mineTimer = null;
    const simulateMineKey = () => {
        const opts = {
            bubbles: true, cancelable: true, charCode: 0, ctrlKey: false,
            location: 0, code: 'Digit5', key: '5', shiftKey: false,
            keyCode: 53, which: 53, repeat: true,
        };
        try {
            doc.body.dispatchEvent(new KeyboardEvent('keydown', opts));
            doc.body.dispatchEvent(new KeyboardEvent('keyup', opts));
        } catch (_) {}
    };
    const stopMineLoop = () => {
        if (mineTimer !== null) {
            try { page.clearInterval(mineTimer); } catch (_) {}
            mineTimer = null;
        }
    };
    const startMineLoop = () => {
        stopMineLoop();
        mineTimer = page.setInterval(simulateMineKey, settings.mineInterval);
    };
    const renderMineUI = () => {
        const host = doc.getElementById(HOST_ID);
        if (!host || !host.shadowRoot) return;
        const btn = host.shadowRoot.getElementById('mine-toggle');
        if (btn) {
            btn.textContent = '[' + (settings.mineHotkey || '无') + '] 地雷 · ' + (settings.mineEnabled ? '运行中' : '已停止');
            btn.classList.toggle('run', settings.mineEnabled);
        }
    };
    const setMineEnabled = (on) => {
        if (isChatFocused()) return; // 聊天框聚焦时忽略，避免打字误开关
        if (on && !nameAuthPassed) { threeToast('未授权：自动地雷已锁定'); return; }
        settings.mineEnabled = !!on;
        if (settings.mineEnabled) startMineLoop(); else stopMineLoop();
        save();
        renderMineUI();
        threeToast(settings.mineEnabled ? '自动地雷开启' : '自动地雷关闭');
    };
    const toggleMine = () => setMineEnabled(!settings.mineEnabled);

    /* ============================================================
     * 战场功能·房间点场（提取自特技脚本 房间点场：A队/B队/混战）
     * 在房间列表监听对应“进入战斗”按钮，按钮一旦可点立即自动点击进入；
     * 超限等模式的入场确认框自动确认。A队与B队可同时开启，二者与混战互斥；
     * 成功进入或再次点击当前模式即停止。不持久化，刷新后复位。
     * ============================================================ */
    const JOIN_OBS = { A: null, B: null, MIX: null };
    let joinDialogObserver = null;   // 三种模式共用一个入场弹窗观察器
    const JOIN_ID = { A: 'join-a', B: 'join-b', MIX: 'join-mix' };
    const JOIN_LABEL = { A: 'A队', B: 'B队', MIX: '混战' };
    const joinActiveModes = () => Object.keys(JOIN_OBS).filter((m) => JOIN_OBS[m] !== null);

    const disconnectOneJoin = (mode) => {
        try { JOIN_OBS[mode] && JOIN_OBS[mode].disconnect(); } catch (_) {}
        JOIN_OBS[mode] = null;
    };
    // 全部模式都停止时，连入场弹窗观察器一起断开
    const refreshDialogObserver = () => {
        if (joinActiveModes().length > 0) return;
        try { joinDialogObserver && joinDialogObserver.disconnect(); } catch (_) {}
        joinDialogObserver = null;
    };
    const stopJoinMode = (mode) => {
        disconnectOneJoin(mode);
        refreshDialogObserver();
        renderJoinUI();
    };
    const stopJoinRoom = () => {
        ['A', 'B', 'MIX'].forEach(disconnectOneJoin);
        refreshDialogObserver();
        renderJoinUI();
    };
    const renderJoinUI = () => {
        const host = doc.getElementById(HOST_ID);
        if (!host || !host.shadowRoot) return;
        ['A', 'B', 'MIX'].forEach((mode) => {
            const b = host.shadowRoot.getElementById(JOIN_ID[mode]);
            if (b) b.classList.toggle('on', JOIN_OBS[mode] !== null);
        });
    };
    // 超限等模式的入场确认弹窗：出现即自动点击“进入”
    const ensureDialogObserver = () => {
        if (joinDialogObserver) return;
        joinDialogObserver = new MutationObserver(() => {
            const dlg = doc.querySelector('.DialogContainerComponentStyle-container');
            const enter = dlg && dlg.querySelector('.DialogContainerComponentStyle-enterButton');
            if (enter) {
                try { enter.click(); } catch (_) {}
                try { joinDialogObserver && joinDialogObserver.disconnect(); } catch (_) {}
                joinDialogObserver = null;
            }
        });
        joinDialogObserver.observe(doc.body, { childList: true, subtree: true });
    };
    const finishJoin = (mode) => {
        threeToast('已进入[' + JOIN_LABEL[mode] + ']');
        stopJoinRoom();
    };
    // 开启 A 队 / B 队（可同时开启，互不影响）
    const startJoinTeam = (mode) => {
        const buttons = doc.querySelectorAll('.JoinToBattleComponentStyle-buttonJoin');
        const el = buttons[mode === 'A' ? 0 : 1];
        if (!el) { threeToast('没有战场可选'); renderJoinUI(); return; }
        // 房间当前已可进入：直接点
        if (!el.classList.contains('ButtonComponentStyle-disabled')) {
            try { el.click(); } catch (_) {}
            finishJoin(mode);
            return;
        }
        JOIN_OBS[mode] = new MutationObserver(() => {
            if (!el.classList.contains('ButtonComponentStyle-disabled')) {
                try { el.click(); } catch (_) {}
                finishJoin(mode);
            }
        });
        JOIN_OBS[mode].observe(el, { attributes: true, attributeFilter: ['class'] });
    };
    // 开启混战：firstChild 出现第二个 class（按钮就绪）即点击
    const startJoinMix = () => {
        let mixEl = null;
        try {
            mixEl = doc.querySelector('.-flexStartAlignCenterColumn .-flexStartAlignStretchColumn').lastChild;
        } catch (_) { mixEl = null; }
        if (!mixEl || !mixEl.firstChild) { threeToast('没有战场可选'); renderJoinUI(); return; }
        JOIN_OBS.MIX = new MutationObserver(() => {
            try {
                if (mixEl.firstChild.classList && mixEl.firstChild.classList.length >= 2) {
                    mixEl.firstChild.click();
                    finishJoin('MIX');
                }
            } catch (_) {}
        });
        JOIN_OBS.MIX.observe(mixEl, { childList: true, subtree: true });
    };
    const toggleJoinMode = (mode) => {
        // 未通过名称白名单授权：点场锁定
        if (!nameAuthPassed) { threeToast('未授权：房间点场已锁定'); renderJoinUI(); return; }
        // 已在监听该模式 => 再次点击仅关闭该模式
        if (JOIN_OBS[mode] !== null) {
            stopJoinMode(mode);
            threeToast('点场[' + JOIN_LABEL[mode] + ']已停止');
            return;
        }
        if (mode === 'MIX') {
            // 混战与 A/B 互斥：开启混战先关掉 A、B
            disconnectOneJoin('A');
            disconnectOneJoin('B');
            startJoinMix();
        } else {
            // 开启 A 或 B：先关掉混战；A、B 之间互不影响，可同时开启
            disconnectOneJoin('MIX');
            startJoinTeam(mode);
        }
        // 原脚本仅在主菜单文本含“超限”时自动确认入场弹窗（其 && 写法实际只匹配“超限”）
        try {
            const menu = doc.querySelector('.MenuComponentStyle-mainMenuItem.-activeMenu');
            if (menu && menu.textContent.includes('超限')) ensureDialogObserver();
        } catch (_) {}
        renderJoinUI();
        if (JOIN_OBS[mode] !== null) {
            threeToast('点场[' + JOIN_LABEL[mode] + ']已开启，等待可进入…');
        }
    };


    const mount = () => {
        if (doc.getElementById(HOST_ID)) return;
        if (!doc.documentElement) {
            page.setTimeout(mount, 0);
            return;
        }
        const host = doc.createElement('div');
        host.id = HOST_ID;
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                :host { all: initial; }
                .panel { position: fixed; top: 16px; left: 16px; z-index: 2147483000; width: 760px;
                    box-sizing: border-box; border: 1px solid rgba(168,85,247,.5); border-radius: 20px;
                    color: #f3efff; overflow: hidden; background: #0a0716;
                    backdrop-filter: blur(12px) saturate(1.3); -webkit-backdrop-filter: blur(12px) saturate(1.3);
                    box-shadow: 0 0 0 1px rgba(34,211,238,.18), 0 26px 70px rgba(70,15,150,.55),
                    0 0 48px rgba(168,85,247,.30);
                    font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif; font-size: 13px;
                    transition: opacity .3s ease, transform .3s ease, visibility .3s ease; }
                .panel.hidden { opacity: 0; visibility: hidden; pointer-events: none;
                    transform: translateY(-10px) scale(.97); }
                /* 启动加载界面结束前强制隐藏；规则必须在影子树内才作用于 .panel */
                .panel.ct-panel-boot { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }
                /* 名称未授权期间：主悬浮窗一律不可见、不可交互（优先级最高） */
                .panel.ct-auth-locked { opacity: 0 !important; visibility: hidden !important;
                    pointer-events: none !important; transform: translateY(-10px) scale(.97); }
                .sky { position: absolute; inset: 0; width: 100%; height: 100%; display: block; z-index: 0; }
                .veil { position: absolute; inset: 0; z-index: 1; pointer-events: none;
                    background: linear-gradient(160deg, rgba(20,12,42,.58), rgba(14,10,30,.52) 55%, rgba(10,6,22,.62)); }
                .inner { position: relative; z-index: 2; }
                @keyframes headflow { 0%,100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
                /* 顶部整宽横向标题栏（拖动柄），横跨侧栏与内容上方 */
                .topbar { position: relative; display: flex; align-items: center; gap: 12px;
                    padding: 13px 18px; cursor: grab; user-select: none;
                    border-bottom: 1px solid rgba(255,255,255,.14);
                    background: linear-gradient(120deg, rgba(56,189,248,.5), rgba(139,92,246,.58) 45%, rgba(236,72,153,.5));
                    background-size: 220% 220%; animation: headflow 9s ease infinite; }
                .topbar:active { cursor: grabbing; }
                .topbar .top-logo { font-size: 20px; font-weight: 900; color: #fff; letter-spacing: .5px;
                    line-height: 1.2; text-shadow: 0 0 14px rgba(255,255,255,.55); white-space: nowrap; }
                .topbar .top-logo .spark { color: #ffe9a8; text-shadow: 0 0 14px rgba(255,214,120,.95); }
                .topbar .top-sub { font-size: 13px; font-weight: 800; color: #fff; letter-spacing: 5px;
                    padding-left: 12px; border-left: 1px solid rgba(255,255,255,.35); }
                .topbar .top-hint { margin-left: auto; font-size: 11px; font-weight: 700;
                    color: rgba(255,255,255,.9); letter-spacing: .5px; text-align: right; line-height: 1.6;
                    white-space: nowrap; }
                /* 左栏 + 右内容 两栏布局 */
                .shell { display: grid; grid-template-columns: 158px 1fr; min-height: 450px; }
                .sidebar { padding: 14px 10px 12px; display: flex; flex-direction: column; gap: 8px;
                    border-right: 1px solid rgba(168,85,247,.28);
                    background: linear-gradient(180deg, rgba(30,18,60,.55), rgba(12,8,26,.55)); }
                .nav-item { display: flex; align-items: center; gap: 9px; padding: 11px 12px; border-radius: 12px;
                    border: 1px solid transparent; background: transparent; color: rgba(220,214,245,.85);
                    font-size: 14px; font-weight: 800; text-align: left; cursor: pointer;
                    transition: background .2s, color .2s, box-shadow .2s; }
                .nav-item .ico { font-size: 16px; width: 20px; text-align: center; }
                .nav-item:hover { background: rgba(168,85,247,.18); color: #fff; }
                .nav-item.active { color: #fff; border-color: rgba(168,85,247,.55);
                    background: linear-gradient(120deg, rgba(34,211,238,.22), rgba(168,85,247,.28));
                    box-shadow: inset 0 0 16px rgba(168,85,247,.3); }
                .side-ver { margin-top: auto; font-size: 10px; color: rgba(190,180,230,.62);
                    text-align: center; line-height: 1.7; }
                .content { position: relative; padding: 16px 18px; min-width: 0; display: flex; }
                .page { display: none; }
                .page.active { display: block; flex: 1; min-width: 0; animation: pagein .25s ease; }
                @keyframes pagein { from { opacity: 0; transform: translateX(8px); } to { opacity: 1; transform: none; } }
                .body { display: block; }
                button { border: 0; font: inherit; font-weight: 800; cursor: pointer; }
                .toggles { display: grid; grid-template-columns: repeat(3,1fr); gap: 10px; }
                .page .toggles { grid-template-columns: 1fr; }
                .page .toggle-row small { font-size: 12px; }
                .toggle-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center;
                    padding: 10px 12px; border-radius: 14px; background: rgba(255,255,255,.05);
                    border: 1px solid rgba(255,255,255,.08); }
                .toggle-row small { display: block; margin-top: 3px; color: rgba(221,214,255,.72); font-size: 14px; line-height: 1.5; }
                .toggle-row b { color: #f4efff; font-size: 17px; }
                .toggle { position: relative; width: 54px; height: 28px; border-radius: 999px; padding: 0; flex-shrink: 0;
                    background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.18);
                    transition: background .25s, box-shadow .25s; }
                .toggle::after { content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px;
                    border-radius: 50%; background: #d7d2ea; box-shadow: 0 2px 6px rgba(0,0,0,.45);
                    transition: transform .25s, background .25s; }
                .toggle.on { background: linear-gradient(90deg, #22d3ee, #a855f7); border-color: transparent;
                    box-shadow: 0 0 14px rgba(168,85,247,.6); }
                .toggle.on::after { transform: translateX(26px); background: #fff; }
                .toggle:disabled { opacity: .35; cursor: not-allowed; }
                .colors { display: grid; grid-template-columns: repeat(5,1fr); gap: 6px; padding: 2px; }
                label { display: grid; gap: 6px; justify-items: center; color: rgba(228,222,255,.88);
                    font-size: 15px; font-weight: 800; }
                input[type="color"] { width: 40px; height: 40px; padding: 0; border-radius: 50%;
                    border: 2px solid rgba(255,255,255,.28); background: transparent; cursor: pointer;
                    box-shadow: 0 0 10px rgba(0,0,0,.4); }
                .status { padding: 11px 15px; border-radius: 12px; font-size: 12.5px; font-weight: 700; line-height: 1.6;
                    background: linear-gradient(90deg, rgba(34,211,238,.15), rgba(168,85,247,.15), rgba(236,72,153,.12));
                    border: 1px solid rgba(168,85,247,.32); color: #f2ecff;
                    text-shadow: 0 0 12px rgba(192,132,252,.5); }
                /* 首页：flex 纵向三栏——标题贴顶 / 英文+时间占满中间并居中 / 提示框贴底 */
                .page-home.active { display: flex; flex-direction: column; }
.hero { position: relative; flex: 1; min-height: 0; width: 100%;
    display: flex; flex-direction: column; align-items: center;
    text-align: center; padding: 6px 8px; }
                /* 中部：占满标题与底框之间的全部空间，正标题+副标题+时间在其中垂直水平居中 */
                .hero-top { display: flex; flex-direction: column; align-items: center; padding-bottom: 100px; }
                .hero-mid { flex: 1; min-height: 0; width: 100%; gap: 8px;
                    display: flex; flex-direction: column; align-items: center; justify-content: center;
                    padding-bottom: 70px; }
                .hero .hero-brand { font-size: 55px; font-weight: 900; letter-spacing: 2px; line-height: 1.2;
                    color: #fff; text-shadow: 0 0 22px rgba(168,85,247,.7); }
                .hero .hero-brand .spark { color: #ffe9a8; text-shadow: 0 0 18px rgba(255,214,120,.95); }
                .hero .hero-sub { font-size: 27px; font-weight: 800; letter-spacing: 5px;
                    color: rgba(255,255,255,.92); }
                .hero .hero-en { font-size: 20px; font-weight: 900; letter-spacing: 3px;
                    color: rgba(165,243,252,.9); text-transform: uppercase; }
                /* 时间：无方框，大字居中，在英文下方 */
                .hero-clock { margin-top: 4px; }
                .hero-clock .clock-time { font-size: 55px; font-weight: 900; color: #fff; line-height: 1.15;
                    font-variant-numeric: tabular-nums; text-shadow: 0 0 18px rgba(168,85,247,.75); }
                .hero-clock .clock-date { margin-top: 4px; font-size: 16px; font-weight: 800; color: rgba(165,243,252,.9); }
                /* 底部提示：套用原时间方框样式，贴底 */
                /* 底部提示：绝对定位钉在悬浮窗最底部 */
                .hero-tip { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
                    width: calc(100% - 36px); max-width: 480px; padding: 12px 16px;
                    border-radius: 16px; border: 1px solid rgba(168,85,247,.4);
                    background: linear-gradient(160deg, rgba(30,18,60,.7), rgba(12,8,26,.7));
                    box-shadow: inset 0 0 22px rgba(168,85,247,.25), 0 0 20px rgba(56,189,248,.15);
                    font-size: 12px; font-weight: 700; color: rgba(220,214,245,.92); line-height: 1.7;
                    z-index: 3; }
                .section-title { display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
                    font-size: 14px; font-weight: 900; color: #fff; letter-spacing: 1px; }
                .section-title::after { content: ''; flex: 1; height: 1px;
                    background: linear-gradient(90deg, rgba(168,85,247,.6), transparent); }
                /* 战场功能 */
                .bs-card { padding: 12px; border-radius: 14px; text-align: center;
                    border: 1px solid rgba(255,255,255,.12);
                    background: linear-gradient(160deg, rgba(30,18,60,.55), rgba(12,8,26,.55)); }
                .bs-card .bs-k { font-size: 11px; color: rgba(190,180,230,.78); letter-spacing: 1px; }
                .bs-card .bs-v { margin-top: 5px; font-size: 13px; font-weight: 900; color: #a5f3fc; }
                .bs-card .bs-v.bad { color: #fda4af; }
                .bs-card .bs-v.good { color: #6ee7b7; }
                .bt-main { width: 100%; margin-bottom: 14px; padding: 13px; border-radius: 14px;
                    font-size: 15px; font-weight: 900; letter-spacing: 2px; color: #fff;
                    border: 1px solid rgba(168,85,247,.55);
                    background: linear-gradient(120deg, rgba(139,92,246,.45), rgba(236,72,153,.4));
                    box-shadow: 0 0 18px rgba(168,85,247,.35); cursor: pointer; transition: transform .15s, box-shadow .2s; }
                .bt-main:hover { transform: translateY(-1px); }
                .bt-main.run { border-color: rgba(34,197,94,.7);
                    background: linear-gradient(120deg, rgba(22,163,74,.55), rgba(34,211,238,.45));
                    box-shadow: 0 0 22px rgba(34,197,94,.5); }
                .battle-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
                .mini-field { padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,.12);
                    background: rgba(30,18,60,.4); }
                .mini-field label { display: block; font-size: 11px; color: rgba(190,180,230,.8); margin-bottom: 6px; }
                .mini-field input { width: 100%; box-sizing: border-box; background: rgba(6,4,16,.75);
                    border: 1px solid rgba(168,85,247,.4); border-radius: 8px; color: #fff;
                    padding: 6px 9px; font-size: 13px; font-weight: 800; outline: none; }
                /* 键帽式热键框：像按键一样，悬停浮起、按下下陷、录制中高亮脉冲 */
                .mini-field input.hk-keycap { display: block; width: 100%; text-align: center;
                    padding: 9px 10px; font-size: 15px; font-weight: 900; letter-spacing: 2px;
                    color: #f3edff; cursor: pointer; user-select: none;
                    border-radius: 10px;
                    border: 1px solid rgba(168,85,247,.55);
                    background: linear-gradient(180deg, rgba(66,42,120,.85), rgba(28,16,58,.9));
                    box-shadow: 0 3px 0 rgba(20,10,46,.95), 0 5px 12px rgba(0,0,0,.45),
                        inset 0 1px 0 rgba(255,255,255,.14);
                    transition: transform .12s ease, box-shadow .12s ease, border-color .2s, background .2s; }
                .mini-field input.hk-keycap:hover {
                    border-color: rgba(192,132,252,.9);
                    background: linear-gradient(180deg, rgba(92,58,160,.95), rgba(40,22,80,.95));
                    transform: translateY(-1px);
                    box-shadow: 0 4px 0 rgba(20,10,46,.95), 0 8px 16px rgba(139,92,246,.35),
                        inset 0 1px 0 rgba(255,255,255,.2); }
                .mini-field input.hk-keycap:active { transform: translateY(2px);
                    box-shadow: 0 1px 0 rgba(20,10,46,.95), 0 2px 6px rgba(0,0,0,.5),
                        inset 0 2px 6px rgba(0,0,0,.45); }
                .mini-field input.hk-keycap:focus, .mini-field input.hk-keycap.recording {
                    border-color: rgba(34,211,238,.95); color: #fff;
                    background: linear-gradient(180deg, rgba(20,90,110,.9), rgba(12,40,60,.95));
                    box-shadow: 0 0 0 1px rgba(34,211,238,.55), 0 0 16px rgba(34,211,238,.5),
                        inset 0 1px 0 rgba(255,255,255,.18);
                    animation: hkPulse 1s ease-in-out infinite; }
                @keyframes hkPulse { 0%,100% { box-shadow: 0 0 0 1px rgba(34,211,238,.55), 0 0 10px rgba(34,211,238,.4); }
                    50% { box-shadow: 0 0 0 1px rgba(34,211,238,.8), 0 0 22px rgba(34,211,238,.75); } }
                /* 间隔步进器：− [ 20 ms ] ＋ */
                .ms-stepper { display: flex; align-items: stretch; gap: 5px; }
                .ms-btn { width: 30px; flex-shrink: 0; border-radius: 8px; cursor: pointer;
                    font-size: 15px; font-weight: 900; color: #f3edff;
                    border: 1px solid rgba(168,85,247,.5);
                    background: linear-gradient(180deg, rgba(66,42,120,.85), rgba(28,16,58,.9));
                    box-shadow: 0 2px 0 rgba(20,10,46,.9);
                    transition: transform .1s, box-shadow .1s, border-color .2s, background .2s; }
                .ms-btn:hover { border-color: rgba(192,132,252,.9);
                    background: linear-gradient(180deg, rgba(92,58,160,.95), rgba(40,22,80,.95)); }
                .ms-btn:active { transform: translateY(1px); box-shadow: 0 1px 0 rgba(20,10,46,.9); }
                .ms-input { flex: 1; min-width: 0; width: 100%; text-align: center;
                    padding: 6px 4px; font-size: 14px; font-weight: 900; color: #a5f3fc;
                    background: rgba(6,4,16,.85); border: 1px solid rgba(34,211,238,.4);
                    border-radius: 8px; outline: none; font-variant-numeric: tabular-nums;
                    -moz-appearance: textfield; appearance: textfield;
                    transition: border-color .2s, box-shadow .2s; }
                .ms-input::-webkit-outer-spin-button, .ms-input::-webkit-inner-spin-button {
                    -webkit-appearance: none; margin: 0; }
                .ms-input:focus { border-color: rgba(34,211,238,.9);
                    box-shadow: 0 0 12px rgba(34,211,238,.45); }
                .ms-unit { display: grid; place-items: center; flex-shrink: 0; padding: 0 2px;
                    font-size: 11px; font-weight: 800; color: rgba(190,180,230,.8); }
                .ms-range { display: block; margin-top: 6px; font-size: 10.5px; font-weight: 700;
                    color: rgba(190,180,230,.65); text-align: center; }
                .battle-note { font-size: 12px; line-height: 1.9; color: rgba(220,214,245,.85);
                    padding: 12px 14px; border-radius: 12px;
                    border: 1px solid rgba(34,211,238,.25); background: rgba(34,211,238,.07); }
                .battle-note .k { display: inline-block; min-width: 18px; padding: 1px 6px; margin: 0 2px;
                    border-radius: 6px; border: 1px solid rgba(34,211,238,.5);
                    background: rgba(34,211,238,.14); color: #fff; font-weight: 900; text-align: center; }
                /* 战场子区块（地雷 / 房间点场） */
                .battle-sub { margin-top: 18px; margin-bottom: 10px; font-size: 13px; font-weight: 900;
                    letter-spacing: 1px; color: #c4b5fd; display: flex; align-items: center; gap: 8px; }
                .battle-sub::after { content: ''; flex: 1; height: 1px;
                    background: linear-gradient(90deg, rgba(168,85,247,.45), transparent); }
                .join-list { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
                .bt-join { padding: 12px; border-radius: 12px; font-size: 13px; font-weight: 900; letter-spacing: 1px;
                    color: rgba(220,214,245,.92); cursor: pointer;
                    border: 1px solid rgba(255,255,255,.14); background: rgba(30,18,60,.45);
                    transition: transform .15s, box-shadow .2s, border-color .2s; }
                .bt-join:hover { transform: translateY(-1px); border-color: rgba(168,85,247,.6); }
                .bt-join.on { color: #fff; border-color: rgba(34,197,94,.7);
                    background: linear-gradient(120deg, rgba(22,163,74,.55), rgba(34,211,238,.45));
                    box-shadow: 0 0 18px rgba(34,197,94,.45); }
                /* 关于页 */
                .about-card { display: flex; align-items: center; gap: 14px; padding: 14px; border-radius: 16px;
                    border: 1px solid rgba(255,255,255,.12);
                    background: linear-gradient(160deg, rgba(30,18,60,.55), rgba(12,8,26,.55)); margin-bottom: 12px; }
                .about-card .about-avatar { width: 52px; height: 52px; border-radius: 50%; flex-shrink: 0;
                    object-fit: cover; border: 2px solid rgba(168,85,247,.7);
                    box-shadow: 0 0 18px rgba(168,85,247,.55); background: #140c2a; }
                .about-card .about-avatar-fb { display: grid; place-items: center; font-size: 26px;
                    background: linear-gradient(135deg, #22d3ee, #a855f7); }
                .about-card .a-name { font-size: 17px; font-weight: 900; color: #fff; }
                .about-card .a-role { font-size: 11px; color: rgba(165,243,252,.9); margin-top: 3px; letter-spacing: 1px; }
                .about-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
                .about-meta .bs-card { text-align: left; }
                .about-note { font-size: 12px; color: rgba(220,214,245,.82); line-height: 1.9; padding: 12px 14px;
                    border-radius: 12px; border: 1px solid rgba(251,191,36,.3); background: rgba(251,191,36,.07); }
            </style>
            <section class="panel">
                <canvas class="sky"></canvas>
                <div class="veil"></div>
                <div class="inner">
                    <div class="topbar head" title="按住此处可拖动整个面板">
                        <div class="top-logo">☄️ Comet<span class="spark">✦</span>Terminal</div>
                        <div class="top-sub">彗星终端</div>
                        <div class="top-hint">⠿ 按住标题栏拖动面板<br>INS / - 显示 · 隐藏</div>
                    </div>
                    <div class="shell">
                        <nav class="sidebar">
                            <button class="nav-item" data-page="home" type="button"><span class="ico"></span>彗星首页</button>
                            <button class="nav-item" data-page="join" type="button"><span class="ico"></span>房间点场</button>
                            <button class="nav-item" data-page="battle" type="button"><span class="ico"></span>快捷道具</button>
                            <button class="nav-item" data-page="xray" type="button"><span class="ico"></span>透视ESP</button>
                            <button class="nav-item" data-page="about" type="button"><span class="ico"></span>关于彗星</button>
                            <div class="side-ver">Comet Terminal<br>v1.2.5-Comet</div>
                        </nav>
                        <div class="content body">
<section class="page page-home" data-page="home">
    <div class="hero">
        <div class="hero-mid">
            <div class="hero-brand">Comet<span class="spark">✦</span>Terminal</div>
            <div class="hero-sub">彗星终端</div>
            <div class="hero-en">3D Tank Assistant</div>
            <div class="hero-clock">
                <div class="clock-time">--:--:--</div>
                <div class="clock-date">----年--月--日</div>
            </div>
        </div>
        <div class="hero-tip">
            ✦ 划破天际的陨星信号-Comet Terminal 彗星终端已完成加载！
        </div>
    </div>
</section>
                            <section class="page page-battle" data-page="battle">
                                <div class="section-title">战场功能 · 道具三开（调用函数）</div>
                                <button class="bt-main" id="three-toggle" type="button">[9] 三开 · 已停止</button>
                                <div class="battle-row">
                                    <div class="mini-field">
                                        <label>切换热键（点按键后按一个键，留空则只用按钮）</label>
                                        <input class="hk-keycap" id="three-hotkey" type="text" maxlength="12" value="9">
                                    </div>
                                    <div class="mini-field">
                                        <label>道具触发间隔</label>
                                        <div class="ms-stepper">
                                            <button class="ms-btn" type="button" data-target="three-interval" data-delta="-1">−</button>
                                            <input class="ms-input" id="three-interval" type="number" min="10" max="50" step="1" value="20">
                                            <span class="ms-unit">ms</span>
                                            <button class="ms-btn" type="button" data-target="three-interval" data-delta="1">＋</button>
                                        </div>
                                        <small class="ms-range">范围 50–100ms.50ms为极限,再低界面则崩溃</small>
                                    </div>
                                </div>
                                <div class="battle-note">
                                    ✦ 进入战场后内核自动扫描并调用游戏函数持续触发道具，不注入不发包；<br>
                                    ✦ 热键 <span class="k" id="three-hk-note">9</span> 可随时开/关三开；聊天框输入时不会误触；<br>
                                    ✦ 与游戏内道具键位分离，不会与正常使用道具冲突。
                                </div>

                                <div class="battle-sub">地雷脚本</div>
                                <button class="bt-main" id="mine-toggle" type="button">[F4] 地雷 · 已停止</button>
                                <div class="battle-row">
                                    <div class="mini-field">
                                        <label>切换热键（点按键后按一个键，留空则只用按钮）</label>
                                        <input class="hk-keycap" id="mine-hotkey" type="text" maxlength="12" value="F4">
                                    </div>
                                    <div class="mini-field">
                                        <label>布雷触发间隔</label>
                                        <div class="ms-stepper">
                                            <button class="ms-btn" type="button" data-target="mine-interval" data-delta="-1">−</button>
                                            <input class="ms-input" id="mine-interval" type="number" min="20" max="50" step="1" value="23">
                                            <span class="ms-unit">ms</span>
                                            <button class="ms-btn" type="button" data-target="mine-interval" data-delta="1">＋</button>
                                        </div>
                                        <small class="ms-range">范围 20–50ms，越小布雷越快</small>
                                    </div>
                                </div>
                                <div class="battle-note">
                                    ✦ 开启后持续模拟游戏内的地雷键 <span class="k">5</span>，连续下雷；<br>
                                    ✦ 间隔可点 ＋/− 或直接输入数字，修改后立即按新间隔运行；聊天框输入时热键不误触。
                                </div>
                            </section>
                            <section class="page page-join" data-page="join">
                                <div class="section-title">点场功能 · 自动加入</div>
                                <div class="join-list">
                                    <button class="bt-join" id="join-a" type="button">🔵 A 队</button>
                                    <button class="bt-join" id="join-b" type="button">🔴 B 队</button>
                                    <button class="bt-join" id="join-mix" type="button">⚪ 混战</button>
                                </div>
                                <div class="battle-note">
                                    ✦ 在大厅房间列表开启对应模式后，目标队伍一旦可进入即自动点击进入；<br>
                                    ✦ A队 与 B队 可同时开启；混战与 A/B 互斥，成功进入或再次点击当前模式即停止；<br>
                                    ✦ 超限等模式弹出的入场确认框会自动确认；本项不记忆，刷新后自动复位。
                                </div>
                            </section>
                            <section class="page page-xray" data-page="xray">
                                <div class="section-title">透视功能 · ESP 轮廓 / ID</div>
                        <div class="toggles">
                            <div class="toggle-row"><div><b>敌方ESP</b><small>总开关-开启后，才可 开/关 队友ESP！</small></div><button class="toggle outline" type="button"></button></div>
                            <div class="toggle-row"><div><b>队友ESP</b><small>总开关开启后，单独控制 开/关 ESP队友！</small></div><button class="toggle ally-outline" type="button"></button></div>
                            <div class="toggle-row"><div><b>距离限制</b><small>消除游戏距离限制. 无视距离显示！</small></div><button class="toggle ids" type="button"></button></div>
                        </div>
                        <div class="colors">
                            <label>敌方<input class="enemy" type="color"></label>
                            <label>队友<input class="ally" type="color"></label>
                            <label>可击中<input class="hittable" type="color"></label>
                            <label>无敌中<input class="invincible" type="color" title="敌方出生/复活无敌保护时间的轮廓色"></label>
                            <label>AI人机<input class="bot" type="color" title="敌方人机（AI）轮廓色，用于区分真人玩家"></label>
                        </div>
                                <div class="status">✦ 点击ARGB区块进行调节颜色！</div>
                            </section>
                            <section class="page page-about" data-page="about">
                                <div class="section-title">关于彗星</div>
                                <div class="about-card">
                                    <img class="about-avatar" id="about-qq-avatar" alt="作者 QQ 头像" title="作者 QQ：669481357">
                                    <div>
                                        <div class="a-name">作者：T_T</div>
                                        <div class="a-role">COMET TERMINAL · 3D Tank Assistant</div>
                                    </div>
                                </div>
                                <div class="about-meta">
                                    <div class="bs-card"><div class="bs-k">QQ 联系</div><div class="bs-v">669481357</div></div>
                                    <div class="bs-card"><div class="bs-k">当前版本</div><div class="bs-v">v1.2.5-Comet</div></div>
                                </div>
                                <div class="about-note" style="margin-top:12px;">✦ 本终端纯本人一人编辑，无第三方任何人参与编辑，请放心使用！<br>✦ 功能仅限白名单授权玩家使用；脚本功能均在名称校验通过后解锁。</div>
                            </section>
                        </div>
                    </div>
                </div>
            </section>`;
        doc.documentElement.appendChild(host);

        const panel = shadow.querySelector('.panel');
        // 名称授权通过前，主悬浮窗始终强制隐藏（ct-auth-locked），
        // 且启动加载界面结束前同样保持隐藏；授权通过后由 unlockPanel() 解除。
        panel.classList.add('ct-panel-boot', 'ct-auth-locked');
        const head = shadow.querySelector('.head');
        const sky = shadow.querySelector('.sky');
        const outline = shadow.querySelector('.outline');
        const allyOutline = shadow.querySelector('.ally-outline');
        const ids = shadow.querySelector('.ids');
        const enemy = shadow.querySelector('.enemy');
        const ally = shadow.querySelector('.ally');
        const hittable = shadow.querySelector('.hittable');
        const invincible = shadow.querySelector('.invincible');
        const bot = shadow.querySelector('.bot');
        const status = shadow.querySelector('.status');
        const aboutAvatar = shadow.querySelector('#about-qq-avatar');
        if (aboutAvatar) {
            aboutAvatar.onerror = () => {
                // 头像加载失败时降级显示 ☄️ 占位，保证布局不破
                const fb = document.createElement('div');
                fb.className = 'about-avatar about-avatar-fb';
                fb.textContent = '☄️';
                aboutAvatar.replaceWith(fb);
            };
            aboutAvatar.src = 'https://q2.qlogo.cn/g?b=qq&nk=669481357&s=100';
        }
        const clockTime = shadow.querySelector('.clock-time');
        const clockDate = shadow.querySelector('.clock-date');
        const pad2 = (n) => String(n).padStart(2, '0');
        const tickClock = () => {
            const d = new Date();
            clockTime.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
            clockDate.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
        };
        tickClock();
        setInterval(tickClock, 1000);

        /* ---------- 侧栏页签 ---------- */
        const navItems = Array.from(shadow.querySelectorAll('.nav-item'));
        const pages = Array.from(shadow.querySelectorAll('.page'));
        const switchPage = (name, persist) => {
            navItems.forEach((b) => b.classList.toggle('active', b.dataset.page === name));
            pages.forEach((p) => p.classList.toggle('active', p.dataset.page === name));
            settings.activePage = name;
            if (persist) save();
            page.requestAnimationFrame(() => resizeSky());
        };
        navItems.forEach((b) => b.addEventListener('click', () => switchPage(b.dataset.page, true)));
        switchPage(settings.activePage || 'home', false);

        /* ---------- 战场功能·道具三开（固定：护甲 / 伤害 / 加速） ---------- */
        const threeBtn = shadow.getElementById('three-toggle');
        const threeHotkeyInput = shadow.getElementById('three-hotkey');
        const threeIntervalInput = shadow.getElementById('three-interval');
        const threeHkNote = shadow.getElementById('three-hk-note');
        threeHotkeyInput.value = settings.threeHotkey;
        threeIntervalInput.value = String(settings.threeInterval);
        threeHkNote.textContent = settings.threeHotkey || '无';
        const renderThreePanel = () => {
            threeBtn.textContent = '[' + (settings.threeHotkey || '无') + '] 三开 · ' + (settings.threeEnabled ? '运行中' : '已停止');
            threeBtn.classList.toggle('run', settings.threeEnabled);
        };
        renderThreePanel();
        threeBtn.addEventListener('click', () => toggleThree());
        // 热键录制：聚焦即进入“等待按键”态（键帽脉冲高亮），按任意键设为切换键（Esc 清除为“无”）
        threeHotkeyInput.addEventListener('focus', () => threeHotkeyInput.classList.add('recording'));
        threeHotkeyInput.addEventListener('blur', () => threeHotkeyInput.classList.remove('recording'));
        threeHotkeyInput.addEventListener('keydown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const k = e.key === 'Escape' ? '' : (e.key || '');
            settings.threeHotkey = k;
            threeHotkeyInput.value = k;
            threeHkNote.textContent = k || '无';
            save();
            renderThreePanel();
            threeHotkeyInput.blur();
        });
        // 道具触发间隔：50–100ms，可直接输入或点 ＋/−
        const applyThreeInterval = (n) => {
            const v = Math.max(50, Math.min(100, Math.round(Number.isFinite(n) ? n : settings.threeInterval)));
            settings.threeInterval = v;
            threeIntervalInput.value = String(v);
            save();
            threeRefreshTimers();
        };
        threeIntervalInput.addEventListener('change', () => {
            applyThreeInterval(parseInt(threeIntervalInput.value, 10));
        });

        /* ---------- 战场功能·自动地雷 ---------- */
        const mineBtn = shadow.getElementById('mine-toggle');
        const mineHotkeyInput = shadow.getElementById('mine-hotkey');
        const mineIntervalInput = shadow.getElementById('mine-interval');
        mineHotkeyInput.value = settings.mineHotkey;
        mineIntervalInput.value = String(settings.mineInterval);
        const renderMinePanel = () => {
            mineBtn.textContent = '[' + (settings.mineHotkey || '无') + '] 地雷 · ' + (settings.mineEnabled ? '运行中' : '已停止');
            mineBtn.classList.toggle('run', settings.mineEnabled);
        };
        renderMinePanel();
        mineBtn.addEventListener('click', () => toggleMine());
        // 地雷热键录制（Esc 清空为“无”，此时仅按钮可开关）；聚焦期间键帽脉冲高亮
        mineHotkeyInput.addEventListener('focus', () => mineHotkeyInput.classList.add('recording'));
        mineHotkeyInput.addEventListener('blur', () => mineHotkeyInput.classList.remove('recording'));
        mineHotkeyInput.addEventListener('keydown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const k = e.key === 'Escape' ? '' : (e.key || '');
            settings.mineHotkey = k;
            mineHotkeyInput.value = k;
            save();
            renderMinePanel();
            mineHotkeyInput.blur();
        });
        // 布雷触发间隔：20–50ms，可直接输入或点 ＋/−
        const applyMineInterval = (n) => {
            const v = Math.max(20, Math.min(50, Math.round(Number.isFinite(n) ? n : settings.mineInterval)));
            settings.mineInterval = v;
            mineIntervalInput.value = String(v);
            save();
            if (settings.mineEnabled) startMineLoop(); // 运行中修改：按新间隔重启
        };
        mineIntervalInput.addEventListener('change', () => {
            applyMineInterval(parseInt(mineIntervalInput.value, 10));
        });

        // 间隔步进按钮（− / ＋）：通过 data-target 关联对应输入框
        shadow.querySelectorAll('.ms-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const input = shadow.getElementById(btn.dataset.target);
                if (!input) return;
                const tgt = btn.dataset.target;
                const cur = parseInt(input.value, 10);
                const base = Number.isFinite(cur) ? cur
                    : (tgt === 'three-interval' ? settings.threeInterval : settings.mineInterval);
                const next = base + (btn.dataset.delta === '-1' ? -1 : 1);
                if (tgt === 'three-interval') applyThreeInterval(next);
                else applyMineInterval(next);
            });
        });

        /* ---------- 战场功能·房间点场 ---------- */
        const joinBtns = {
            A: shadow.getElementById('join-a'),
            B: shadow.getElementById('join-b'),
            MIX: shadow.getElementById('join-mix'),
        };
        Object.keys(joinBtns).forEach((mode) => {
            if (joinBtns[mode]) joinBtns[mode].addEventListener('click', () => toggleJoinMode(mode));
        });
        renderJoinUI();

        enemy.value = settings.enemy;
        ally.value = settings.ally;
        hittable.value = settings.hittable;
        invincible.value = settings.invincible;
        bot.value = settings.bot;

        const renderButtons = () => {
            outline.classList.toggle('on', settings.outline);
            allyOutline.classList.toggle('on', settings.allyOutline);
            // 队友轮廓从属于总开关：总开关关闭时禁用按钮，避免误操作无反馈。
            allyOutline.disabled = !settings.outline;
            ids.classList.toggle('on', settings.ids);
        };
        const applyVisibility = () => panel.classList.toggle('hidden', settings.hidden);
        applyVisibility();
        // 状态栏已固定为加载欢迎语，运行时诊断信息不再覆盖它。
        const renderState = () => {};
        renderButtons();
        renderState(runtime.getState());

        outline.addEventListener('click', () => {
            settings.outline = !settings.outline;
            save();
            renderButtons();
            renderState(runtime.setEnabled(settings.outline, { reason: 'standalone-outline-toggle' }));
        });
        allyOutline.addEventListener('click', () => {
            settings.allyOutline = !settings.allyOutline;
            save();
            renderButtons();
            renderState(runtime.setAllyOutlineEnabled(settings.allyOutline, { reason: 'standalone-ally-outline-toggle' }));
        });
        ids.addEventListener('click', () => {
            settings.ids = !settings.ids;
            save();
            renderButtons();
            renderState(runtime.setIdEnabled(settings.ids, { reason: 'standalone-id-toggle' }));
        });
        const onColor = () => {
            settings.enemy = enemy.value;
            settings.ally = ally.value;
            settings.hittable = hittable.value;
            settings.invincible = invincible.value;
            settings.bot = bot.value;
            save();
            applyColors();
        };
        enemy.addEventListener('input', onColor);
        ally.addEventListener('input', onColor);
        hittable.addEventListener('input', onColor);
        invincible.addEventListener('input', onColor);
        bot.addEventListener('input', onColor);
        page.addEventListener(STATE_EVENT, (event) => renderState(event.detail));

        /* ---------- 精细流星背景 ---------- */
        const ctx = sky.getContext('2d');
        let W = 0, H = 0, dpr = 1;
        const TAU = Math.PI * 2;
        const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        const hexA = (hex, a) => {
            const n = Number.parseInt(hex.slice(1), 16);
            return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
        };
        const STAR_COLORS = ['#e9d5ff', '#bae6fd', '#ffffff', '#fbcfe8', '#ddd6fe'];
        const METEOR_COLORS = ['#67e8f9', '#c084fc', '#f0abfc', '#a5f3fc', '#f5d0fe'];
        let stars = [], dust = [], meteors = [], sparks = [];
        const rand = (a, b) => a + Math.random() * (b - a);
        const resizeSky = () => {
            const rect = panel.getBoundingClientRect();
            W = Math.max(1, rect.width); H = Math.max(1, rect.height);
            dpr = Math.min(page.devicePixelRatio || 1, 2);
            sky.width = Math.round(W * dpr); sky.height = Math.round(H * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            stars = [];
            const sn = Math.round(clampNum(W * H / 1400, 46, 150));
            for (let i = 0; i < sn; i++) {
                const big = Math.random() < 0.07;
                stars.push({ x: Math.random() * W, y: Math.random() * H,
                    r: big ? rand(1.5, 2.4) : rand(0.3, 1.2),
                    a: rand(0.35, 0.9), tw: rand(0.0008, 0.004), ph: rand(0, TAU), big,
                    c: STAR_COLORS[(Math.random() * STAR_COLORS.length) | 0] });
            }
            dust = [];
            const dn = Math.round(clampNum(W * H / 7000, 12, 46));
            for (let i = 0; i < dn; i++) {
                dust.push({ x: Math.random() * W, y: Math.random() * H, r: rand(0.3, 1.2),
                    a: rand(0.08, 0.3), vx: rand(-0.012, 0.012), vy: rand(0.004, 0.022),
                    tw: rand(0.0006, 0.003), ph: rand(0, TAU) });
            }
        };
        const spawnMeteor = () => {
            const fromLeft = Math.random() < 0.5;
            const angle = (16 + Math.random() * 18) * Math.PI / 180;
            const sp = rand(180, 320); // 像素/秒
            const fireball = Math.random() < 0.22;
            const m = {
                x: fromLeft ? rand(-60, W * 0.35) : rand(W * 0.65, W + 60),
                y: rand(-40, H * 0.55),
                vx: Math.cos(angle) * sp * (fromLeft ? 1 : -1),
                vy: Math.sin(angle) * sp,
                life: 0, maxLife: rand(2400, 4000),
                size: fireball ? rand(2.0, 2.8) : rand(1.2, 1.9),
                fireball, trail: [], maxTrail: fireball ? 60 : 34,
                c: METEOR_COLORS[(Math.random() * METEOR_COLORS.length) | 0] };
            meteors.push(m);
            return m;
        };
        const burst = (m) => {
            for (let i = 0; i < 22; i++) {
                const a = Math.random() * TAU, sp = rand(60, 260);
                sparks.push({ x: m.x, y: m.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                    life: 0, maxLife: rand(350, 800), r: rand(0.8, 2.2), c: m.c });
            }
        };
        let acc = 0, last = performance.now(), raf = 0;
        const frame = (now) => {
            raf = page.requestAnimationFrame(frame);
            const dt = Math.min(50, now - last); last = now;
            const t = now;
            if (settings.hidden) return; // 冻结最后一帧，随面板一起淡出
            ctx.clearRect(0, 0, W, H);
            const bg = ctx.createLinearGradient(0, 0, W, H);
            bg.addColorStop(0, '#160b30'); bg.addColorStop(0.5, '#120a2a'); bg.addColorStop(1, '#080516');
            ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
            // 流动极光带：紫 / 蓝 / 粉，缓慢漂移 + 呼吸明暗
            const auroras = [
                { bx: 0.22 + 0.10 * Math.sin(t * 0.00021), by: 0.30 + 0.06 * Math.cos(t * 0.00017),
                  rx: 0.62, ry: 0.42, a: 0.34 + 0.10 * Math.sin(t * 0.0009), c: '34,211,238' },
                { bx: 0.62 + 0.12 * Math.cos(t * 0.00016), by: 0.36 + 0.08 * Math.sin(t * 0.00022),
                  rx: 0.66, ry: 0.46, a: 0.36 + 0.11 * Math.sin(t * 0.0007 + 2), c: '168,85,247' },
                { bx: 0.85 + 0.07 * Math.sin(t * 0.00019 + 1), by: 0.72 + 0.07 * Math.cos(t * 0.00015),
                  rx: 0.58, ry: 0.44, a: 0.30 + 0.09 * Math.sin(t * 0.0008 + 4), c: '236,72,153' },
                { bx: 0.30 + 0.09 * Math.cos(t * 0.00014), by: 0.85 + 0.06 * Math.sin(t * 0.0002),
                  rx: 0.55, ry: 0.40, a: 0.22 + 0.07 * Math.sin(t * 0.0006 + 1), c: '129,140,248' } ];
            for (const n of auroras) {
                const cx = n.bx * W, cy = n.by * H, rx = n.rx * W, ry = n.ry * H;
                const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
                g.addColorStop(0, `rgba(${n.c},${Math.max(0, n.a)})`);
                g.addColorStop(0.55, `rgba(${n.c},${Math.max(0, n.a * 0.4)})`);
                g.addColorStop(1, `rgba(${n.c},0)`);
                ctx.globalAlpha = 1; ctx.fillStyle = g;
                ctx.save(); ctx.translate(cx, cy); ctx.scale(1, ry / rx); ctx.translate(-cx, -cy);
                ctx.beginPath(); ctx.arc(cx, cy, rx, 0, TAU); ctx.fill(); ctx.restore();
            }
            ctx.globalAlpha = 1;
            for (const d of dust) {
                d.x += d.vx * dt; d.y -= d.vy * dt;
                if (d.y < -8) { d.y = H + 8; d.x = Math.random() * W; }
                if (d.x < -8) d.x = W + 8; if (d.x > W + 8) d.x = -8;
                ctx.globalAlpha = d.a * (0.6 + 0.4 * Math.sin(t * d.tw + d.ph));
                ctx.fillStyle = '#d9c8f2';
                ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, TAU); ctx.fill();
            }
            for (const s of stars) {
                const a = s.a * (0.55 + 0.45 * Math.sin(t * s.tw + s.ph));
                if (s.big) {
                    const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 4);
                    g.addColorStop(0, hexA(s.c, Math.max(0, a))); g.addColorStop(1, hexA(s.c, 0));
                    ctx.globalAlpha = 1; ctx.fillStyle = g;
                    ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 4, 0, TAU); ctx.fill();
                }
                ctx.globalAlpha = Math.max(0, a); ctx.fillStyle = s.c;
                ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.fill();
            }
            ctx.globalAlpha = 1;
            acc += dt;
            if (acc > rand(550, 1200) && meteors.length < 7) { acc = 0; spawnMeteor(); }
            for (let i = meteors.length - 1; i >= 0; i--) {
                const m = meteors[i];
                m.trail.push({ x: m.x, y: m.y });
                if (m.trail.length > m.maxTrail) m.trail.shift();
                const sec = dt / 1000;
                m.x += m.vx * sec; m.y += m.vy * sec; m.life += dt;
                const off = m.x < -140 || m.x > W + 140 || m.y > H + 140;
                if (m.life > m.maxLife || off) { if (m.fireball) burst(m); meteors.splice(i, 1); continue; }
                const pts = m.trail;
                if (pts.length > 1) {
                    ctx.lineCap = 'round';
                    // 外层宽辉光?
                    for (let k = 1; k < pts.length; k++) {
                        const f = k / (pts.length - 1);
                        ctx.globalAlpha = f * 0.35;
                        ctx.strokeStyle = m.c;
                        ctx.lineWidth = Math.max(0.5, m.size * f * 2.4);
                        ctx.beginPath();
                        ctx.moveTo(pts[k - 1].x, pts[k - 1].y);
                        ctx.lineTo(pts[k].x, pts[k].y);
                        ctx.stroke();
                    }
                    // 内层亮芯
                    for (let k = 1; k < pts.length; k++) {
                        const f = k / (pts.length - 1);
                        ctx.globalAlpha = f;
                        ctx.strokeStyle = '#ffffff';
                        ctx.lineWidth = Math.max(0.3, m.size * f * 0.7);
                        ctx.beginPath();
                        ctx.moveTo(pts[k - 1].x, pts[k - 1].y);
                        ctx.lineTo(pts[k].x, pts[k].y);
                        ctx.stroke();
                    }
                    const hg = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.size * 5);
                    hg.addColorStop(0, hexA('#ffffff', 1)); hg.addColorStop(0.25, hexA('#ffffff', 0.8));
                    hg.addColorStop(0.55, hexA(m.c, 0.55)); hg.addColorStop(1, hexA(m.c, 0));
                    ctx.globalAlpha = 1; ctx.fillStyle = hg;
                    ctx.beginPath(); ctx.arc(m.x, m.y, m.size * 5, 0, TAU); ctx.fill();
                }
            }
            for (let i = sparks.length - 1; i >= 0; i--) {
                const s = sparks[i];
                const sec = dt / 1000;
                s.x += s.vx * sec; s.y += s.vy * sec; s.life += dt;
                s.vy += 120 * sec;
                if (s.life > s.maxLife) { sparks.splice(i, 1); continue; }
                ctx.globalAlpha = (1 - s.life / s.maxLife) * 0.95;
                ctx.fillStyle = s.c;
                ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.fill();
            }
            ctx.globalAlpha = 1;
        };
        resizeSky();
        for (let i = 0; i < 4; i++) {
            const m = spawnMeteor();
            m.life = rand(0, m.maxLife * 0.5);
            m.x = rand(-40, W + 40); m.y = rand(-40, H * 0.7);
            // 预填拖尾，让首帧就有完整光轨
            for (let k = m.maxTrail; k > 0; k--) {
                m.trail.push({ x: m.x - m.vx * k * 0.016, y: m.y - m.vy * k * 0.016 });
            }
        }
        raf = page.requestAnimationFrame(frame);
        try { new ResizeObserver(resizeSky).observe(panel); } catch (_) { page.addEventListener('resize', resizeSky); }
        /* ---------- 拖动 ---------- */
        const applyPos = (left, top) => {
            const maxL = Math.max(8, page.innerWidth - panel.offsetWidth - 8);
            const maxT = Math.max(8, page.innerHeight - panel.offsetHeight - 8);
            const L = clampNum(left, 8, maxL), T = clampNum(top, 8, maxT);
            panel.style.left = L + 'px'; panel.style.top = T + 'px';
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
            return { left: L, top: T };
        };
        if (settings.pos) applyPos(settings.pos.left, settings.pos.top);
        let dragging = false, dx = 0, dy = 0;
        head.addEventListener('pointerdown', (e) => {
            dragging = true;
            const rect = panel.getBoundingClientRect();
            dx = e.clientX - rect.left; dy = e.clientY - rect.top;
            try { head.setPointerCapture(e.pointerId); } catch (_) {}
        });
        head.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            applyPos(e.clientX - dx, e.clientY - dy);
        });
        const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            const rect = panel.getBoundingClientRect();
            settings.pos = { left: rect.left, top: rect.top };
            save();
            try { head.releasePointerCapture(e.pointerId); } catch (_) {}
        };
        head.addEventListener('pointerup', endDrag);
        head.addEventListener('pointercancel', endDrag);

        /* ---------- 热键：INS / -_ 显示·隐藏 ---------- */
        const toggleHidden = () => {
            settings.hidden = !settings.hidden;
            save();
            applyVisibility();
            if (!settings.hidden) { resizeSky(); last = performance.now(); }
        };
        page.addEventListener('keydown', (e) => {
            if (splashActive) return; // 加载界面期间热键屏蔽
            if (!nameAuthPassed) return; // 名称授权未通过：主悬浮窗热键一律屏蔽
            // Shadow DOM 内部输入框的事件会被重定向到宿主，需用 composedPath 取真实目标
            const realTarget = (typeof e.composedPath === 'function' && e.composedPath()[0]) || e.target;
            const tag = (realTarget && realTarget.tagName || '').toUpperCase();
            const inEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
                || (realTarget && realTarget.isContentEditable);
            if (inEditable) return;
            if (e.code === 'Insert' || e.code === 'Minus') {
                e.preventDefault();
                toggleHidden();
                return;
            }
            // 三开切换热键（聊天框聚焦或与窗口热键撞键时忽略）
            const hk = settings.threeHotkey;
            if (hk && !isChatFocused() && e.code !== 'Insert' && e.code !== 'Minus'
                && (e.key === hk || e.key.toLowerCase() === String(hk).toLowerCase())) {
                e.preventDefault();
                toggleThree();
                return;
            }
            // 地雷切换热键（同样在聊天框聚焦或输入框聚焦时忽略）
            const mhk = settings.mineHotkey;
            if (mhk && !isChatFocused()
                && (e.key === mhk || e.key.toLowerCase() === String(mhk).toLowerCase())) {
                e.preventDefault();
                toggleMine();
            }
        });
    };

    /* ---------- 全屏加载界面（流星 + 进度条，2s 淡入 / 2.7s 走完 / 0.4s 淡出） ---------- */
    // 加载期间：强制隐藏主功能悬浮窗并屏蔽热键，结束后解除
    let splashActive = true;
    // 名称授权门：未通过前主悬浮窗不可呼出、透视功能不启用。
    let nameAuthPassed = false;
    // 说明：.panel 在 Shadow DOM 内，.ct-panel-boot 隐藏规则写在影子树自己的 <style>（见 mount()），
    // 注入主文档的样式穿不透影子边界，故不使用独立 bootStyle。

    const showSplash = () => {
        const win = window, doc = document;
        const root = doc.createElement('div');
        root.className = 'ct-splash-root';
        root.innerHTML = `
            <style>
                .ct-splash-root{position:fixed;inset:0;z-index:2147483001;
                    font-family:'Segoe UI','Microsoft YaHei UI','Microsoft YaHei',sans-serif;
                    color:#eaf2ff;user-select:none;opacity:0;transition:opacity 2s ease;}
                .ct-splash-root.show{opacity:1;}
                .ct-splash-root.hide{opacity:0;pointer-events:none;transition:opacity .4s ease;}
                .ct-splash-root canvas{position:absolute;inset:0;width:100%;height:100%;display:block;z-index:1;}
                .ct-splash-shade{position:absolute;inset:0;z-index:0;background:rgba(8,5,20,.62);}
                .ct-splash-inner{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;
                    align-items:center;justify-content:center;gap:14px;}
                .ct-splash-title{font-size:min(76px,11vw);font-weight:700;letter-spacing:8px;color:#fff;
                    text-shadow:0 0 22px rgba(168,85,247,.95),0 0 52px rgba(34,211,238,.55);margin-bottom:6px;}
                .ct-splash-avatar{width:min(200px,28vw);height:min(200px,28vw);border-radius:50%;overflow:hidden;
                    border:4px solid rgba(255,255,255,.55);background:rgba(168,85,247,.18);
                    box-shadow:0 0 56px rgba(168,85,247,.75),0 0 0 14px rgba(34,211,238,.10);
                    display:flex;align-items:center;justify-content:center;}
                .ct-splash-slogan{margin-top:10px;font-size:min(48px,7vw);font-weight:700;letter-spacing:10px;color:#fff;
                    text-shadow:0 0 18px rgba(168,85,247,.9),0 0 42px rgba(34,211,238,.5);}
                .ct-splash-author{margin-top:12px;font-size:min(28px,4vw);color:#d9d2f5;}
                .ct-splash-qq{font-size:min(24px,3.6vw);color:#a99fd6;}
                .ct-splash-qq b{color:#eaf2ff;font-weight:700;}
                .ct-splash-progress{width:min(600px,70vw);height:14px;border-radius:7px;margin-top:24px;
                    background:rgba(255,255,255,.14);overflow:hidden;border:1px solid rgba(168,85,247,.35);}
                .ct-splash-bar{height:100%;width:0%;border-radius:7px;
                    background:linear-gradient(90deg,#22d3ee,#a855f7,#ec4899);
                    box-shadow:0 0 20px rgba(168,85,247,.9);}
                .ct-splash-pct{margin-top:14px;font-size:min(24px,3.4vw);color:#b8b0e0;
                    font-variant-numeric:tabular-nums;letter-spacing:2px;}
            </style>
            <div class="ct-splash-shade"></div>
            <canvas class="ct-splash-bg"></canvas>
            <div class="ct-splash-inner">
                <div class="ct-splash-title">Comet Terminal</div>
                <div class="ct-splash-avatar"><svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;display:block" aria-hidden="true">
                    <defs>
                        <radialGradient id="ct-avBg" cx="0.35" cy="0.3" r="0.95">
                            <stop offset="0" stop-color="#0b1a42"/><stop offset="0.55" stop-color="#070d26"/><stop offset="1" stop-color="#030510"/>
                        </radialGradient>
                        <radialGradient id="ct-avNebA" cx="0.5" cy="0.5" r="0.5">
                            <stop offset="0" stop-color="#2a7bd0" stop-opacity=".5"/><stop offset="1" stop-color="#2a7bd0" stop-opacity="0"/>
                        </radialGradient>
                        <radialGradient id="ct-avNebB" cx="0.5" cy="0.5" r="0.5">
                            <stop offset="0" stop-color="#7a4fd0" stop-opacity=".4"/><stop offset="1" stop-color="#7a4fd0" stop-opacity="0"/>
                        </radialGradient>
                        <linearGradient id="ct-avIon" gradientUnits="userSpaceOnUse" x1="64" y1="36" x2="6" y2="88">
                            <stop offset="0" stop-color="#f2fbff" stop-opacity=".95"/><stop offset="0.35" stop-color="#9fd2ff" stop-opacity=".7"/><stop offset="1" stop-color="#9fd2ff" stop-opacity="0"/>
                        </linearGradient>
                        <linearGradient id="ct-avDust" gradientUnits="userSpaceOnUse" x1="62" y1="38" x2="14" y2="90">
                            <stop offset="0" stop-color="#f4f7ff" stop-opacity=".8"/><stop offset="0.5" stop-color="#c8d9f5" stop-opacity=".4"/><stop offset="1" stop-color="#e8dcb8" stop-opacity="0"/>
                        </linearGradient>
                        <radialGradient id="ct-avComa" cx="0.5" cy="0.5" r="0.5">
                            <stop offset="0" stop-color="#ffffff"/><stop offset="0.3" stop-color="#cfeaff" stop-opacity=".85"/>
                            <stop offset="0.7" stop-color="#7db8ff" stop-opacity=".4"/><stop offset="1" stop-color="#7db8ff" stop-opacity="0"/>
                        </radialGradient>
                        <linearGradient id="ct-avCrossX" gradientUnits="userSpaceOnUse" x1="42" y1="36" x2="86" y2="36">
                            <stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.5" stop-color="#ffffff" stop-opacity=".8"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
                        </linearGradient>
                        <linearGradient id="ct-avCrossY" gradientUnits="userSpaceOnUse" x1="64" y1="18" x2="64" y2="54">
                            <stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.5" stop-color="#ffffff" stop-opacity=".8"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
                        </linearGradient>
                        <filter id="ct-avBlur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.8"/></filter>
                    </defs>
                    <rect width="96" height="96" fill="url(#ct-avBg)"/>
                    <ellipse cx="26" cy="22" rx="32" ry="20" fill="url(#ct-avNebA)" opacity=".8"/>
                    <ellipse cx="74" cy="72" rx="34" ry="22" fill="url(#ct-avNebB)" opacity=".75"/>
                    <path d="M64 36 L6 88" stroke="url(#ct-avIon)" stroke-width="3.4" stroke-linecap="round" filter="url(#ct-avBlur)"/>
                    <path d="M62 38 C44 56, 28 72, 12 88" stroke="url(#ct-avDust)" stroke-width="7" stroke-linecap="round" fill="none" filter="url(#ct-avBlur)" opacity=".85"/>
                    <path d="M60 40 C46 56, 36 70, 22 86" stroke="url(#ct-avDust)" stroke-width="3.4" stroke-linecap="round" fill="none" filter="url(#ct-avBlur)" opacity=".6"/>
                    <circle cx="64" cy="36" r="17" fill="url(#ct-avComa)" filter="url(#ct-avBlur)"/>
                    <path d="M42 36 L86 36" stroke="url(#ct-avCrossX)" stroke-width="0.8"/>
                    <path d="M64 18 L64 54" stroke="url(#ct-avCrossY)" stroke-width="0.8"/>
                    <circle cx="64" cy="36" r="4.4" fill="#ffffff"/>
                    <circle cx="64" cy="36" r="1.9" fill="#eaf6ff"/>
                    <g fill="#ffffff">
                        <circle cx="18" cy="34" r="1.2" opacity=".8"/><circle cx="30" cy="12" r="1" opacity=".65"/>
                        <circle cx="46" cy="20" r="0.9" opacity=".7"/><circle cx="82" cy="24" r="1.1" opacity=".75"/>
                        <circle cx="88" cy="52" r="1" opacity=".6"/><circle cx="76" cy="80" r="1.2" opacity=".7"/>
                        <circle cx="40" cy="82" r="0.9" opacity=".55"/><circle cx="12" cy="66" r="1" opacity=".6"/>
                    </g>
                    <circle cx="18" cy="34" r="3.2" fill="#ffffff" opacity=".18"/>
                    <circle cx="82" cy="24" r="3" fill="#cfe2ff" opacity=".16"/>
                </svg></div>
                <div class="ct-splash-slogan">彗翼乘风 星赴此约</div>
                <div class="ct-splash-author">作者：T_T</div>
                <div class="ct-splash-qq">QQ：<b>669481357</b></div>
                <div class="ct-splash-progress"><div class="ct-splash-bar"></div></div>
                <div class="ct-splash-pct">0%</div>
            </div>`;
        doc.documentElement.appendChild(root);

        /* ----- 全屏流星（与面板同款小而慢，密度略高） ----- */
        const cv = root.querySelector('.ct-splash-bg');
        const ctx = cv.getContext('2d');
        const TAU = Math.PI * 2;
        const COLORS = ['#67e8f9', '#c084fc', '#f0abfc', '#a5f3fc', '#f5d0fe'];
        const rnd = (a, b) => a + Math.random() * (b - a);
        let SW = win.innerWidth, SH = win.innerHeight;
        let stars = [], mets = [], sparks = [], SR = 0, sAcc = 0, sLast = performance.now(), done = false;
        const resize = () => {
            const sdpr = Math.min(win.devicePixelRatio || 1, 2);
            SW = win.innerWidth; SH = win.innerHeight;
            cv.width = Math.round(SW * sdpr); cv.height = Math.round(SH * sdpr);
            ctx.setTransform(sdpr, 0, 0, sdpr, 0, 0);
            stars = [];
            const n = Math.round(Math.min(220, SW * SH / 9000));
            for (let i = 0; i < n; i++) {
                const big = Math.random() < 0.06;
                stars.push({ x: Math.random() * SW, y: Math.random() * SH,
                    r: big ? rnd(1.6, 2.6) : rnd(0.4, 1.3),
                    a: rnd(0.3, 0.95), tw: rnd(0.0008, 0.004), ph: rnd(0, TAU), big });
            }
        };
        const spawn = () => {
            const left = Math.random() < 0.5;
            const ang = (16 + Math.random() * 18) * Math.PI / 180;
            const sp = rnd(260, 460);
            const fb = Math.random() < 0.2;
            mets.push({ x: left ? rnd(-60, SW * 0.4) : rnd(SW * 0.6, SW + 60),
                y: rnd(-40, SH * 0.55),
                vx: Math.cos(ang) * sp * (left ? 1 : -1), vy: Math.sin(ang) * sp,
                life: 0, maxLife: rnd(2000, 3400),
                size: fb ? rnd(2.2, 3.0) : rnd(1.3, 2.1),
                fb, trail: [], maxTrail: fb ? 54 : 32,
                c: COLORS[(Math.random() * COLORS.length) | 0] });
        };
        const burst = (m) => {
            for (let i = 0; i < 18; i++) {
                const a = Math.random() * TAU, sp = rnd(60, 240);
                sparks.push({ x: m.x, y: m.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                    life: 0, maxLife: rnd(350, 750), r: rnd(0.8, 2.0), c: m.c });
            }
        };
        const sframe = (now) => {
            if (done) return;
            SR = win.requestAnimationFrame(sframe);
            const dt = Math.min(50, now - sLast); sLast = now;
            const sec = dt / 1000;
            ctx.clearRect(0, 0, SW, SH);
            for (const s of stars) {
                const a = s.a * (0.55 + 0.45 * Math.sin(now * s.tw + s.ph));
                if (s.big) {
                    const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 4);
                    g.addColorStop(0, `rgba(255,255,255,${Math.max(0, a)})`);
                    g.addColorStop(1, 'rgba(255,255,255,0)');
                    ctx.globalAlpha = 1; ctx.fillStyle = g;
                    ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 4, 0, TAU); ctx.fill();
                }
                ctx.globalAlpha = Math.max(0, a); ctx.fillStyle = '#e9e6ff';
                ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.fill();
            }
            ctx.globalAlpha = 1;
            sAcc += dt;
            if (sAcc > rnd(300, 700) && mets.length < 9) { sAcc = 0; spawn(); }
            for (let i = mets.length - 1; i >= 0; i--) {
                const m = mets[i];
                m.trail.push({ x: m.x, y: m.y });
                if (m.trail.length > m.maxTrail) m.trail.shift();
                m.x += m.vx * sec; m.y += m.vy * sec; m.life += dt;
                if (m.life > m.maxLife || m.x < -140 || m.x > SW + 140 || m.y > SH + 140) {
                    if (m.fb) burst(m); mets.splice(i, 1); continue;
                }
                const pts = m.trail;
                if (pts.length > 1) {
                    ctx.lineCap = 'round';
                    for (let k = 1; k < pts.length; k++) {
                        const f = k / (pts.length - 1);
                        ctx.globalAlpha = f * 0.32; ctx.strokeStyle = m.c;
                        ctx.lineWidth = Math.max(0.5, m.size * f * 2.4);
                        ctx.beginPath(); ctx.moveTo(pts[k - 1].x, pts[k - 1].y);
                        ctx.lineTo(pts[k].x, pts[k].y); ctx.stroke();
                    }
                    for (let k = 1; k < pts.length; k++) {
                        const f = k / (pts.length - 1);
                        ctx.globalAlpha = f; ctx.strokeStyle = '#ffffff';
                        ctx.lineWidth = Math.max(0.3, m.size * f * 0.7);
                        ctx.beginPath(); ctx.moveTo(pts[k - 1].x, pts[k - 1].y);
                        ctx.lineTo(pts[k].x, pts[k].y); ctx.stroke();
                    }
                    const hg = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.size * 5);
                    hg.addColorStop(0, 'rgba(255,255,255,1)'); hg.addColorStop(0.25, 'rgba(255,255,255,.8)');
                    hg.addColorStop(0.55, 'rgba(192,132,252,.5)'); hg.addColorStop(1, 'rgba(192,132,252,0)');
                    ctx.globalAlpha = 1; ctx.fillStyle = hg;
                    ctx.beginPath(); ctx.arc(m.x, m.y, m.size * 5, 0, TAU); ctx.fill();
                }
            }
            for (let i = sparks.length - 1; i >= 0; i--) {
                const s = sparks[i];
                s.x += s.vx * sec; s.y += s.vy * sec; s.life += dt; s.vy += 120 * sec;
                if (s.life > s.maxLife) { sparks.splice(i, 1); continue; }
                ctx.globalAlpha = (1 - s.life / s.maxLife) * 0.95; ctx.fillStyle = s.c;
                ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.fill();
            }
            ctx.globalAlpha = 1;
        };
        const onResize = () => resize();
        win.addEventListener('resize', onResize);
        resize();
        for (let i = 0; i < 6; i++) {
            spawn();
            const m = mets[mets.length - 1];
            m.life = rnd(0, m.maxLife * 0.4);
            m.x = rnd(0, SW); m.y = rnd(0, SH * 0.7);
        }
        SR = win.requestAnimationFrame(sframe);

        /* ----- 进度条：2s 淡入期间同步走，2.7s 走完，0.4s 淡出；Esc 可跳过 ----- */
        const bar = root.querySelector('.ct-splash-bar');
        const pct = root.querySelector('.ct-splash-pct');
        const DUR = 2700, t0 = performance.now();
        const cleanup = () => {
            if (done) return;
            done = true;
            win.cancelAnimationFrame(SR);
            win.removeEventListener('resize', onResize);
            win.removeEventListener('keydown', onKey);
            root.classList.remove('show');
            root.classList.add('hide');
            setTimeout(() => { root.remove(); splashActive = false; window.dispatchEvent(new CustomEvent('ct-splash-done')); }, 450);
        };
        const onKey = (e) => { if (e.code === 'Escape') cleanup(); };
        win.addEventListener('keydown', onKey);
        root.classList.add('show'); // 2s 淡入
        const step = (now) => {
            const p = Math.min(1, (now - t0) / DUR);
            bar.style.width = (p * 100).toFixed(1) + '%';
            pct.textContent = Math.round(p * 100) + '%';
            if (p < 1 && !done) win.requestAnimationFrame(step);
            else if (!done) cleanup();
        };
        win.requestAnimationFrame(step);
    };

    /* ---------- 名称授权门：加载界面结束后判定并弹出的独立悬浮窗 ----------
     * 加载结束后后台轮询大厅顶栏的本机玩家名称（不弹窗）：
     *  - 命中白名单：解锁功能与主悬浮窗，弹欢迎窗
     *    「携漫天陨星而来，赴一场星下之约，欢迎使用彗星终端！」
     *  - 未命中：功能保持锁定、热键屏蔽，弹拒绝窗
     *    「很遗憾，您不是白名单玩家，无法正常使用彗星终端。」
     * 两种窗右上角均有关闭按钮；拒绝窗即使关闭，功能依旧锁定。 */
    const showAuthGate = () => {
        const win = window;
        if (AUTHORIZED_SET.size === 0) {
            console.warn('[CometTerminal] 名称白名单为空：请先在脚本 AUTHORIZED_NAMES 中填入授权名称。');
        }
        const GATE_ID = 'standalone-tank-name-auth-gate';
        if (doc.getElementById(GATE_ID)) return;

        const host = doc.createElement('div');
        host.id = GATE_ID;
        host.setAttribute('style', 'all:initial;position:fixed;inset:0;z-index:2147483646;display:none;pointer-events:none;');
        doc.documentElement.appendChild(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                .gw { position:fixed; inset:0; display:grid; place-items:center; pointer-events:none; }
                .card { pointer-events:auto; position:relative; width:400px; box-sizing:border-box; padding:26px 26px 22px;
                    border-radius:18px; border:1px solid rgba(168,85,247,.55);
                    background:linear-gradient(165deg,rgba(20,12,42,.97),rgba(10,7,22,.98)); color:#f3efff;
                    box-shadow:0 0 0 1px rgba(34,211,238,.18),0 24px 70px rgba(70,15,150,.6),0 0 46px rgba(168,85,247,.32);
                    font-family:"Microsoft YaHei UI","Segoe UI",sans-serif; text-align:center;
                    transition:opacity .3s ease,transform .3s ease; }
                .card.hide { opacity:0; transform:scale(.95) translateY(-8px); }
                .x { position:absolute; right:10px; top:8px; width:26px; height:26px; border:0; cursor:pointer;
                    border-radius:8px; background:rgba(255,255,255,.08); color:rgba(255,255,255,.85);
                    font-size:15px; line-height:26px; text-align:center; padding:0; }
                .x:hover { background:rgba(255,90,90,.35); color:#fff; }
                .logo { font-size:33px; font-weight:900; letter-spacing:1px; color:#fff; text-shadow:0 0 16px rgba(255,255,255,.45); }
                .logo .sp { color:#ffe9a8; text-shadow:0 0 16px rgba(255,214,120,.95); }
                .sub { margin-top:4px; font-size:18px; font-weight:800; color:rgba(216,180,254,.95); letter-spacing:3px; }
                .msg { margin:18px 0 6px; font-size:18px; font-weight:800; line-height:1.9; }
                .msg.ok { color:#8ef0a8; text-shadow:0 0 14px rgba(74,222,128,.4); }
                .msg.no { color:#ff8a8a; text-shadow:0 0 14px rgba(255,90,90,.35); }
                .pname { margin:10px auto 2px; font-size:14px; color:rgba(205,196,240,.8); }
                .pname b { color:#fff; font-size:16px; }
                .foot { margin-top:14px; font-size:12px; color:rgba(180,170,220,.65); line-height:1.6; }
            </style>
            <div class="gw"><div class="card">
                <button class="x" type="button" title="关闭">✕</button>
                <div class="logo">Comet<span class="sp">✦</span>Terminal</div>
                <div class="sub">彗星终端</div>
                <div class="msg"></div>
                <div class="pname">当前玩家：<b class="val">—</b></div>
                <div class="foot"></div>
            </div></div>`;

        const card = shadow.querySelector('.card');
        const msgEl = shadow.querySelector('.msg');
        const valEl = shadow.querySelector('.val');
        const footEl = shadow.querySelector('.foot');
        const closeBtn = shadow.querySelector('.x');

        let shown = false;
        let finished = false;
        // 关闭按钮：欢迎窗关闭后照常使用；拒绝窗关闭后功能仍保持锁定。
        const closeCard = () => {
            if (!shown) return;
            card.classList.add('hide');
            win.setTimeout(() => host.remove(), 320);
        };
        closeBtn.addEventListener('click', closeCard);

        const reveal = (mode, name) => {
            if (shown) return;
            shown = true;
            valEl.textContent = name || '—';
if (mode === 'ok') {
    msgEl.className = 'msg ok';
    msgEl.innerHTML = '携漫天陨星而来，赴一场星下之约<br>欢迎使用彗星终端！';
    footEl.textContent = 'Insert / - 呼出窗口　·　' + (settings.threeHotkey || '9') + ' 键快速开关道具三开';
} else {
    msgEl.className = 'msg no';
    msgEl.innerHTML = '漫野陨芒皆散尽，星河旧约不能寻<br>未能启用彗星终端！';
    footEl.textContent = '透视功能已保持锁定，主悬浮窗无法呼出';
}
            host.style.display = 'block';
        };

        const unlockPanel = () => {
            const mainHost = doc.getElementById(HOST_ID);
            const mainPanel = mainHost && mainHost.shadowRoot
                && mainHost.shadowRoot.querySelector('.panel');
            if (mainPanel) {
                mainPanel.classList.remove('ct-panel-boot', 'ct-auth-locked');
                // 验证通过即展示主悬浮窗（之后用户可用 Insert / - 自行隐藏/呼出）
                if (settings.hidden) {
                    settings.hidden = false;
                    save();
                    mainPanel.classList.remove('hidden');
                }
            }
        };
        const unlockFeatures = () => {
            applyColors();
            runtime.setEnabled(settings.outline, { reason: 'standalone-name-auth-pass-outline' });
            runtime.setAllyOutlineEnabled(settings.allyOutline, { reason: 'standalone-name-auth-pass-ally' });
            runtime.setIdEnabled(settings.ids, { reason: 'standalone-name-auth-pass-ids' });
            // 三开为 Worker 内联门控（检查 nameAuthPassed），授权通过即按本地设置自动恢复
            renderThreeUI();
            // 自动地雷为页面定时器：授权通过后按本地设置恢复
            if (settings.mineEnabled) startMineLoop();
            renderMineUI();
        };
        // 白名单玩家：解锁功能并弹欢迎窗
        const grant = (name) => {
            if (finished) return;
            finished = true;
            nameAuthPassed = true;
            unlockPanel();
            unlockFeatures();
            reveal('ok', name);
            try { win.clearInterval(timer); } catch (_) {}
            // 欢迎窗 8 秒后自动淡出，也可点右上角关闭
            win.setTimeout(closeCard, 8000);
        };
        // 非白名单玩家：功能保持锁定，弹拒绝窗（不自动消失，只能手动关闭）
        const deny = (name) => {
            if (finished) return;
            finished = true;
            // 三开同样强制关闭并持久化，杜绝本地曾开启时的残留状态
            settings.threeEnabled = false;
            save();
            renderThreeUI();
            // 自动地雷一并强制关闭
            settings.mineEnabled = false;
            stopMineLoop();
            save();
            renderMineUI();
            stopJoinRoom();
            reveal('no', name);
            try { win.clearInterval(timer); } catch (_) {}
        };
        let started = false;
        let timer = 0;
        const tick = () => {
            if (finished) return;
            const got = readLobbyPlayerName();
            if (!got.name) return; // 还没进入大厅/读不到名称：静默等待，不弹窗
            if (isNameAuthorized(got.name)) grant(got.name);
            else deny(got.name);
        };
        const start = () => {
            if (started) return;
            started = true;
            tick();
            if (!finished) timer = win.setInterval(tick, 800);
        };
        // 加载界面结束后才开始判定
        if (!splashActive) start();
        else win.addEventListener('ct-splash-done', start, { once: true });
    };

    showSplash();
    mount();
    showAuthGate();
})();
