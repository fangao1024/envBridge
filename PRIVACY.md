# EnvBridge 隐私政策

版本：1.1.0。更新日期：2026-09-29。

EnvBridge 只在用户选择、授权的源与目标网站之间迁移浏览器状态。Cookie、localStorage、sessionStorage 和 IndexedDB 的读取、转换、写入与校验全部在用户设备本地完成。

EnvBridge 没有远程服务器、账号、遥测或广告，不会上传、出售或共享网页数据。扩展的运行时代码不包含网络发送逻辑，其扩展页面 CSP 禁止网络连接。用户手动输入网站时，打开该网站会产生浏览器正常的页面请求；这不属于向 EnvBridge 上传数据。

持久保存的信息仅包括环境预设（名称、源 / 目标 Origin、数据类别及策略）和扩展设置。预览数据保留在临时内存中，十分钟后失效；页面传输缓冲在使用后释放并有超时清理。

为了提供历史撤销，迁移前会将受影响的目标 Cookie、Storage 值和 IndexedDB 记录及结构保存到扩展的 `chrome.storage.session`。这些快照包含恢复所需的原始数据值，仅在浏览器会话内存中保留，不写入扩展的持久存储，不上传或同步。最多保存 10 条记录，内存预算 6 MiB，达到上限时释放较早记录；用户可随时清空历史。撤销成功后释放该条快照，重启浏览器、禁用、重新加载或更新扩展会清空全部历史。关闭弹窗或后台工作进程重启时，会话快照仍保留。

任务状态仅在当前浏览器会话保存，包含所选 Origin、状态、项目名、数量、时间及错误，不包含 Cookie / Token / Storage / IndexedDB 记录值。预览不展示网页数据值。

权限用途：

- `cookies`：读取源主机可访问 Cookie，并写入目标主机。
- `scripting`：在选择的标签页读写 Storage 和 IndexedDB。
- `tabs`：提供标签页地址选择、按需打开环境与刷新目标。
- `storage`：持久保存预设与设置；会话内存保存不含数据值的任务状态以及包含原始目标数据的撤销快照。会话快照仅向扩展自己的可信页面开放。
- 可选网站权限：用户主动选择环境时请求。迁移 Cookie 时，额外请求当前主机和合法父域的 HTTP / HTTPS 权限，以读取父域与非 Secure Cookie；不请求兄弟子域的通配访问。主机权限范围由浏览器规则决定，可能涵盖其他端口；网页存储操作始终校验完整 Origin，Cookie 读取也按所选主机过滤。

用户可以删除预设、清空历史、在浏览器扩展管理页撤销网站授权或卸载扩展。清空历史和卸载不会修改已经迁移到目标网站的网页数据；如需恢复，应先在当前会话的历史中撤销。

支持与反馈：安装和排错说明位于项目 README.md。请仅提供浏览器版本、步骤及错误码，不提供 Token、Cookie 值或数据库记录。正式商店版本的维护者需要补充公开支持网址。

## English

EnvBridge processes browser storage locally on the user's device. It does not upload, sell, or share cookies, localStorage, sessionStorage, or IndexedDB data. There are no accounts, remote servers, telemetry, or advertising services.

Only environment presets and settings persist in extension-local storage. Undo snapshots contain original destination values and database schemas in extension session memory, with up to ten entries and a 6 MiB budget. They are not uploaded, synced, or written to persistent extension storage. Snapshots survive popup closure and service-worker restarts, but are cleared on browser restart or extension disable, reload, update, or removal. Public history metadata, task status, and logs do not include website values. Users can clear history at any time; clearing or uninstalling does not undo destination changes.
