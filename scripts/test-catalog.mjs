// 按文件的主要测试边界分类；一个文件内可能包含少量其他层级的断言。
// 新增或移动测试时同步登记。所有测试仍保留在显式全量范围内。
export const layers = {
  unit: [
    "account-state", "album-metadata-lookup", "audio", "client-reliability", "config", "library-data", "lyrics-timing",
    "legacy-client-state", "library-pages", "login-scene", "mobile-layout", "playback-position", "playlist-state",
    "prototype-accounts", "prototype-login-scene", "prototype-state", "room-catalog", "room-state", "seek-input"
  ],
  integration: [
    "accounts-integration", "album-enrichment", "album-grouping", "album-metadata", "album-metadata-consensus", "artwork", "artwork-import",
    "auth", "legacy-auth", "data-lock", "db", "library-pagination", "lighting", "maintenance", "media", "media-connection", "metadata", "pathSafety",
    "playlist-client", "playlists", "routes", "runtime-startup", "scan-recovery", "scanner"
  ]
};

// 这里选择 unit/integration 的近似覆盖；真实浏览器流程另用 test:e2e 选择。
export const scopes = {
  "media-connection": { description: "NAS 媒体握手、跨域访问、账号隔离与凭证撤销", tests: ["media-connection", "config"] },
  atmosphere: { description: "正式氛围模式的声音特征分析、只读缓存与并发边界", tests: ["lighting"] },
  playback: { description: "音频策略、HTTP/转码、进度、手势、队列及播放器反馈", tests: [
    "audio", "media", "routes", "playback-position", "seek-input", "mobile-layout", "library-data", "client-reliability"
  ] },
  playlists: { description: "歌单 API/客户端契约、并发、隔离、加载与生产排序逻辑", tests: [
    "playlists", "playlist-client", "room-state", "accounts-integration", "room-catalog"
  ] },
  catalog: { description: "索引、搜索、分页、专辑合并与客户端目录", tests: [
    "db", "routes", "album-grouping", "library-pagination", "library-data", "room-catalog"
  ] },
  scan: { description: "增量扫描、清理保护、中断恢复、路径与终态反馈", tests: [
    "scanner", "scan-recovery", "pathSafety", "config", "client-reliability", "album-enrichment", "accounts-integration"
  ] },
  metadata: { description: "歌词/封面缓存、专辑查询与覆盖、后台补全", tests: [
    "metadata", "artwork", "lyrics-timing", "album-metadata", "album-metadata-lookup", "album-metadata-consensus", "album-enrichment", "scanner", "accounts-integration", "room-catalog"
  ] },
  auth: { description: "当前账号认证/权限/会话、生产账号表单与登录背景", tests: [
    "accounts-integration", "auth", "account-state", "login-scene", "config"
  ] },
  paths: { description: "路径和符号链接、扫描及媒体/维护入口保护", tests: [
    "pathSafety", "routes", "scanner", "accounts-integration", "artwork", "artwork-import", "maintenance", "data-lock"
  ] },
  maintenance: { description: "备份恢复、数据锁、启动排他、封面导入与扩展用户状态", tests: [
    "maintenance", "data-lock", "runtime-startup", "artwork-import", "accounts-integration", "album-metadata", "album-enrichment", "scan-recovery"
  ] },
  ui: { description: "当前界面的可测逻辑；不含真实 DOM、布局或浏览器事件验证", tests: [
    "mobile-layout", "seek-input", "playback-position", "client-reliability", "library-data", "room-catalog", "album-metadata-lookup", "account-state", "room-state", "login-scene"
  ] },
  legacy: { description: "当前生产入口未使用的旧客户端逻辑及旧认证路径；仍保留", tests: [
    "library-pages", "playlist-state", "legacy-auth", "legacy-client-state"
  ] },
  prototype: { description: "独立 listening-room 原型；仍包含在 unit 和全量中", tests: [
    "prototype-login-scene", "prototype-accounts", "prototype-state"
  ] }
};

export const testPath = (name) => `tests/${name}.test.ts`;
