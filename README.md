# EnvBridge

将 Cookie、localStorage、sessionStorage 和 IndexedDB 从一个浏览器环境迁移到另一个环境。基于 [index.md](index.md) 的需求实现，1.1 增加 Cookie 域名作用域映射、会话历史与撤销。支持 Chromium 系列的 Chrome / Edge，界面支持简体中文和 English。

## 安装

无需构建，也无需安装 npm 依赖即可使用扩展。

1. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。
2. 开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本项目目录 `E:\mycode\envBridge`（包含 `manifest.json` 的目录）。
4. 打开源环境和目标环境，点击 EnvBridge 图标。

分发包为 `dist/envbridge-1.1.1.zip`。解压后加载包含 `manifest.json` 的目录即可；ZIP 不包含测试依赖和开发工具。当前版本未发布到扩展商店。

最低要求：Chrome / Edge Chromium 120。具体浏览器构建仍需按下方清单验收。

## 使用

1. 选择 **Source** 与 **Target** 标签页。完整显示协议、主机与端口；同 Origin 的不同标签页分别列出，以正确选择 sessionStorage。
2. 也可选择「手动输入网站地址」。扩展会优先使用同 Origin 的现有标签页；没有时打开一个后台标签页。网站发生跨 Origin 重定向时需要重新选择。
3. 选择数据类别及策略，点击「预览变更」或「迁移所选数据」。首次读取会请求所选网站的权限；选择 Cookies 时还需要当前主机及合法父域的 HTTP / HTTPS 权限，以覆盖普通与 Secure Cookie。
4. 预览中逐项选择 Cookie、Storage Key 或 IndexedDB 数据库，查看属性变更、数据库结构、数量、估算大小和兼容警告。
5. 点击「开始迁移」。每类数据按顺序写入并校验，失败不阻止其他类别执行。结果页显示成功数量、跳过项和错误。
6. 可保存环境预设，或选择迁移成功后刷新目标页。右上角 **↗** 可打开独立工作台。
7. 在「历史记录」查看当前会话的迁移，点击「撤销修改」恢复目标数据；有多次迁移时按时间倒序撤销。
8. 在「设置 → 界面语言」选择「简体中文」或「English」。语言立即生效并自动保存，无需点击「保存设置」；下次打开仍使用所选语言。已打开的弹窗、独立工作台与隐私政策会同步切换。

默认策略是 Cookie **Rewrite**、Storage **Merge**、IndexedDB **Merge**，默认先预览、不自动刷新。清空 Storage、替换数据库和大库迁移需要再次确认；此确认不会因关闭默认预览而省略。

首次使用默认为简体中文。语言设置只影响界面文字、提示、确认对话框、结果和日志；预设名称、网页标题、Storage Key、数据库名称与网站数据保留原样。切换语言保留当前预览的勾选与未保存的迁移设置。

## 数据行为

| 类别 | 实现 |
| --- | --- |
| Cookie | 使用 `chrome.cookies`，读取可访问的主机及父域 Cookie，包含 HttpOnly 与非根 Path；保留会话/过期、HttpOnly 和 Path 属性。 |
| Rewrite | 保留 Cookie 的 host-only / Domain 作用域。`.51miz.com` → `www.dev.com` 时写为 `.dev.com`；主机 Cookie 写为 `www.dev.com` 且不设置 Domain。合法子域作用域按层级映射，保留原有前导点形式。localhost 和 IP 使用 host-only；HTTP 目标的普通 Secure Cookie 降级并展示警告，SameSite=None 必要时改为 Lax。 |
| Preserve | 保留原属性，仅允许 Domain、协议和前缀约束兼容的目标；不兼容项在预览中标记。 |
| 特殊 Cookie | 校验 `__Host-`、`__Secure-`、`__Http-`、`__Host-Http-`；HTTPS 约束不满足时跳过；重写导致同名同路径冲突时提示而不任意覆盖。 |
| Web Storage | Merge 与 Overwrite 都覆盖选中的同名 Key，保留其他 Key；Clear & Clone 清空对应目标 Storage 后仅写入选中 Key。写入失败会尝试恢复原状态。 |
| sessionStorage | 精确绑定所选源 / 目标标签页的顶层文档。 |
| IndexedDB | 选择整个数据库，复制版本、Object Store、keyPath、autoIncrement、Index、主键与记录；Merge 保留目标额外表和记录，按需升级结构；Replace 删除同名数据库并按源版本重建。 |
| IDB 类型 | 保留 Date、Blob、File、ArrayBuffer、TypedArray、DataView、Map、Set、RegExp、BigInt、undefined、循环 / 共享引用等。遇到无法表达的类型（如 CryptoKey）明确失败。 |
| 批量传输 | 每批最多 500 条记录，传输文本切分成 512 Ki 字符块；批次写入使用事务，之后按主键重新读取并比较记录内容。 |
| 校验 | Storage 比较选中 Key 的值，Cookie 比较值及属性，IndexedDB 比较每批实际值、数据库结构与替换后的版本 / 数量。 |

## 历史记录与撤销

每次迁移先读取目标的实际数据并保存撤销快照，保存成功后才开始修改。快照使用扩展的 `chrome.storage.session`，只在浏览器会话内存中保留，不写入 `storage.local` 或磁盘文件；关闭弹窗、插件后台重启不会丢失，重启浏览器、禁用、更新或重新加载扩展会清空。

- 最多 10 条记录，快照总预算为 6 MiB，为浏览器的会话存储配额保留余量。达到条数或内存预算时释放最早记录；单次快照过大或无法保存时，会在修改目标前报错。
- Cookie：恢复覆盖前的值和属性，删除本次新增的 Cookie；不同作用域的无关 Cookie 不受影响。已经自然过期的原 Cookie 不会被重新复活。同名作用域导致删除无法精确定位时，报错而不删除其他 Cookie。
- Merge / Overwrite Storage：恢复本次选中的 Key，删除本次新增的 Key，保留其他 Key。Clear & Clone：恢复整份对应 Storage。
- IndexedDB：恢复受影响数据库的原版本、结构、索引、主键、富类型记录以及自增键生成器；移除本次新建的数据库。其他数据库不受影响。
- 支持部分失败或后台中断的迁移。撤销部分失败时，保留快照并允许重试剩余项目。为防止旧快照覆盖后续迁移，按时间倒序撤销。
- 撤销数据库或整份 Storage 会覆盖其迁移后发生的修改，确认框会说明恢复范围。sessionStorage 必须恢复到原目标标签页；已经关闭的标签页无法恢复其会话存储。
- 「清空历史」只删除撤销快照，不修改网站数据。历史列表、进度与日志不展示网页数据值。

## 边界与故障排查

- **源与目标必须是不同 Origin**。扩展仅操作顶层文档，不迁移 iframe 内的独立或分区存储。
- **Cookie 不按端口隔离**。同主机不同端口共用 Cookie，预览会提示写入同时影响源主机下的其他页面；不同主机映射到一个 Cookie 标识时会检测冲突。
- **网站权限**由浏览器按协议 / 主机授予，可能覆盖同主机其他端口；实际存储操作始终检查完整 Origin 与 `documentId`。受保护的浏览器页面、扩展商店页面无法注入脚本。
- **已授权却显示 Cookie 为 0**：以 `https://www.51miz.com` 为例，完整读取需要 `http://www.51miz.com/*`、`https://www.51miz.com/*`、`http://51miz.com/*` 和 `https://51miz.com/*`。父域 Cookie 的权限检查使用 Cookie 自身的域名。更新后重新加载扩展，再次预览并允许新增权限。实际读取仍按所选主机过滤，排除兄弟子域与父域 host-only Cookie。权限不足显示明确错误，不当作没有 Cookie。
- **Only permissions specified in the manifest may be requested**：1.0.1 请求了 `*://域名/*`，但 manifest 将 HTTP / HTTPS 分别声明，导致 Chrome 的单项匹配检查拒绝请求。已将当前主机与合法父域的权限请求和检查拆为明确的 HTTP / HTTPS 模式。请确认扩展管理页显示 1.1.1；若从解压目录安装，先用新版覆盖该目录，再重新加载并预览。
- **An unknown error occurred when fetching the script**：这是 Chrome 的 Service Worker 注册错误，不足以单独判断是项目文件还是浏览器配置。先在 `chrome://extensions` 核对版本和后台入口；1.1.1 的入口应为 `src/background.bundle.js`。直接打开 `chrome-extension://oojpfjkiblplinkcgdpfcdggkjfiklpg/popup.html`（ID 仅适用于本项目当前目录）可区分工具栏按钮与扩展页面故障。如果页面能打开但点击图标无反应，先在扩展管理页关闭再开启 EnvBridge，并在工具栏拼图菜单取消固定、重新固定，不会删除预设。在 `chrome://serviceworker-internals/` 搜索该扩展 ID，可检查脚本路径和状态；需要重建注册时只对这个 ID 点「Unregister」，再回到扩展管理页重新加载。不要清除整个浏览器的 Service Worker 或卸载扩展，以免影响其他站点或清空预设。
- **点击图标和「检查弹出内容」均无反应，但直接打开 HTML 正常**：已复现外部 SVG `<use href="assets/icons.svg#…">` 在隐藏弹窗中阻塞页面加载完成，Chrome 等待 `load` 后才显示弹窗。当前代码把图标符号内联到 `popup.html`，静态与动态图标都使用同页 `#icon-…` 引用。更新项目目录后，在扩展管理页点击 EnvBridge 的「重新加载」。新增 `test:popup` 从 `chrome.action.openPopup()` 验证真正的工具栏弹窗，不以普通标签页代替。扩展卡片的「Service Worker（无效）」对应 `Inactive`，空闲挂起本身不代表注册失败。
- **不支持无痕窗口、分区 Cookie 和隐藏的浏览器内部类型**。不可迁移项会显示原因。没有请求全网站的永久访问权限。
- **没有跨类别全局事务**。Cookie 逐项写入，Storage 按类别处理，IndexedDB 按批事务提交；失败时先前已成功的批次会保留，可通过当前会话的历史撤销恢复。会话历史不代替长期备份。
- **IndexedDB 被占用**：Merge 的结构升级最多等待 12 秒；超时后晚到的升级会被中止。Replace 的 `deleteDatabase` 无法撤销，遇到阻塞会明确显示等待状态，直到页面连接关闭。请通过应用提供的方式关闭连接，或关闭其他同 Origin 页面；不要刷新当前迁移标签页。
- **浏览器或后台进程重启**会丢失临时预览。后台重启后任务可能中断，但会话撤销快照仍在；重启浏览器会清空历史。普通关闭弹窗不会取消后台任务。
- **源数据库是实时数据**。迁移前检查版本、结构、记录数，传输期间检查实际数量；同数量的并发更新无法形成数据库级一致快照。建议停止应用写入后迁移。
- **IDB Merge** 不会降低目标已有版本；新结构可能将版本提升至源版本或目标版本 + 1。Replace 重建为源版本。
- **autoIncrement**：从源数据库迁移时按现有主键生成目标计数器。目标撤销快照通过一个会回滚的探测事务读取原计数器，因此撤销能恢复已删除记录留下的自增键进度。
- **估算大小**来自每表最多 10 条采样记录的传输大小，包含序列化开销，不是数据库实际磁盘占用。100,000 条记录或估算 100 MB 以上会提示；单条巨大 Blob / Record 仍需足够内存。
- 迁移数据中的 URL、API 地址和 Token 内容保持原值；只重写 Cookie 属性。服务端绑定域名 / 环境的登录态可能需要重新登录。

## 开发与测试

交付扩展不需要运行时依赖或构建。后台源码在开发时打包为单个 `src/background.bundle.js`，避免 Chrome 注册 Service Worker 时分别抓取多级导入文件。合法父域解析使用随扩展本地打包的 tldts / Public Suffix List；运行时无需下载数据。该列表包括私有后缀，避免把 `co.uk` 或 `github.io` 当作可以申请的 Cookie 父域。

```powershell
npm.cmd install
npm.cmd run build:background
npm.cmd run check
npm.cmd test

$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\.playwright"
npx.cmd playwright install chromium --no-shell
npm.cmd run test:popup
npm.cmd run test:popup -- --edge
npm.cmd run test:i18n
npm.cmd run test:i18n -- --edge
npm.cmd run test:browser
npm.cmd run test:browser -- --edge
npm.cmd run test:cookies
npm.cmd run test:cookies -- --edge
npm.cmd run test:history
npm.cmd run test:history -- --edge

npm.cmd run package
node tools/verify-package.mjs
```

`npm.cmd` 避免 Windows PowerShell 的 npm.ps1 执行策略问题。Node >=20。

修改 `src/background.js` 或其导入的模块后，先运行 `npm.cmd run build:background`，再到 `chrome://extensions` 点击 EnvBridge 的「重新加载」。仅加载现成的项目目录或分发包时，不需要 Node.js。

- 单元与适配器测试验证 Cookie 兼容、数据类型、Storage 失败恢复、数据库版本 / 结构 / 索引、二进制主键和唯一索引事务回滚。
- 浏览器集成测试使用隔离的临时 Chromium profile 和两个 loopback 主机，执行真正的 MV3 后台、UI、Cookie API 和页面注入；测试 1,204 条包含丰富类型的源记录、Merge、逐项选择、清空确认取消、被占用数据库替换、持久化和导航保护。
- 无头浏览器无法接受原生网站授权弹窗，因此 **仅测试用的临时 manifest** 分别预授权 HTTP / HTTPS 的 `127.0.0.1` 和 `localhost`，不使用协议通配符；交付 manifest 保持 optional-only。Cookie 专项回归使用本地拦截页面与伪造 Cookie，验证“2 个父域 Cookie 实际存在、旧 HTTPS 子域授权读取为 0”，通过真实点击复现旧版通配符请求的 manifest 报错，再验证修复后的授权检查、预览与 3 个 Cookie 迁移，不连接真实 51miz 网站。首次授权、拒绝授权和撤销授权弹窗需人工验收。
- 历史专项测试覆盖父域 / localhost、四种存储、关闭 UI、后台重启、清空 / 替换恢复、自增键、部分失败、倒序撤销及备份配额在写入前阻止修改。
- 中英文专项测试覆盖设置切换、语言持久化、多页面同步、预览选择与未保存设置保留、静态文字及无障碍属性、英文迁移 / 撤销流程、中文用户数据保持原值，以及 460 × 600 弹窗布局。
- 集成结果和截图输出到 `artifacts/`。测试数据均为 fixture，不使用真实账号信息。

已通过 Chromium 153.0.8010.12 和 Microsoft Edge 154.0.4258.37 的真实扩展集成测试，详情见 [验证记录](docs/validation.md)。

本地手动验证：

```powershell
npm.cmd run demo
```

打开控制台给出的源与目标地址，在各页面点击「初始化当前环境」，再用扩展迁移。测试页面可占用 / 释放数据库连接以复现阻塞。

## 人工验收清单

在 Chrome 和 Edge 各执行一次：

1. 加载扩展，确认无安装 / CSP 错误；初始无全网站授权。
2. 选择两个网站，首次预览确认按需请求所选主机；启用 Cookie 时还包含合法父域的 HTTP / HTTPS 权限。拒绝后没有迁移数据；再次允许后可预览。
3. 对 HTTPS → HTTP 检查 Secure / SameSite 警告和特殊 Cookie 跳过行为。
4. 源同 Origin 打开两个标签页，设置不同 sessionStorage，分别选择迁移，确认目标只接收指定标签页的数据。
5. 使用测试页面验证 Merge、Cancel、Replace、Clear & Clone、取消确认、自动刷新和手动刷新。
6. 迁移大库时关闭弹窗，重新打开查看进度；故意刷新标签页，确认报告部分失败而不误报完成。
7. 从扩展管理页面撤销网站授权，再次操作应重新申请；删除预设，重新打开确认删除。

## 目录

```text
manifest.json           可直接加载的 MV3 manifest
popup.html              弹窗与独立工作台
privacy.html            扩展内隐私政策
src/background.js       权限检查、预览、任务与预设服务
src/core/               Origin、Cookie 重写、Diff、序列化、配置
src/vendor/             本地公共后缀解析库与许可证
src/adapters/page.js    隔离世界的 Storage / IndexedDB 适配器
src/ui/                 中英文界面、翻译、样式
assets/                 SVG Logo 和 PNG 扩展图标
tests/                  单元、适配器、真实浏览器集成测试
tools/                  演示服务器、检查、图标生成与 ZIP 打包
docs/store-listing.md   商店描述及权限说明
```

隐私政策见 [PRIVACY.md](PRIVACY.md)。正式发布前需填写支持网址、项目网址及公开托管的隐私政策链接，并分别完成 Chrome / Edge 商店审核。

API 依据：[Chrome cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)、[scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)、[optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)、[IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)、[Edge 移植说明](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension)。
