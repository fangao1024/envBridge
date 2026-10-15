# 商店发布资料

## 名称与描述

名称：EnvBridge

短描述：Clone cookies, Web Storage and IndexedDB between development environments.

完整描述：

EnvBridge helps developers clone browser state between production, staging, testing and local development environments. Move cookies, localStorage, sessionStorage and IndexedDB between user-selected origins, with cookie compatibility checks, per-item selection, migration previews and write verification.

Save environment mappings for repeated tasks. IndexedDB migration includes database versions, object stores, indexes, primary keys and records. All migration data is processed locally on your device; there are no accounts, remote servers or analytics.

EnvBridge supports Chrome and Chromium-based Microsoft Edge. Website access is requested for the environments you select; cookie migration also requests HTTP / HTTPS access for their eligible parent cookie domains. Domain cookies keep their eligible parent scope, while localhost and IP destinations use host-only cookies. Clear & Clone and Replace Database require explicit confirmation. Version 1.1 adds session-memory history and undo for all four storage types, including partial migrations. There is no persistent backup or cloud sync.

中文描述：在用户选择的环境之间迁移 Cookie、Web Storage 与 IndexedDB，提供属性兼容处理、逐项选择、迁移预览、环境预设和写入校验。所有网页数据仅在设备本地处理。

## 单一用途

Clone browser storage and state between user-selected development environments.

## 权限说明

| 权限 | 用途 |
| --- | --- |
| cookies | 读取所选源环境 Cookie、写入目标环境，包含 HttpOnly。 |
| scripting | 在选择的顶层页面读写 localStorage、sessionStorage 和 IndexedDB。 |
| tabs | 展示可选页面的地址与标题，定位所选标签页、按需打开环境和刷新目标。 |
| storage | 持久保存预设、设置；会话内存保存任务状态和用于历史撤销的原始目标快照，用户可清空，不上传、不写入持久存储。 |
| optional_host_permissions | 用户选择环境后按需请求主机访问权限；启用 Cookie 迁移时，包含所选主机及合法父域的 HTTP / HTTPS 权限，以读取适用于该主机的父域 Cookie。 |

无远程代码、广告、后台数据采集或默认的永久全网站访问。

## 发布前需补充

- 维护者的 GitHub / 项目网址、真实支持 URL、联系信息。
- 公开托管 `PRIVACY.md` 内容，并填写隐私政策 URL。
- 商店要求尺寸的产品截图；`artifacts/` 提供测试环境操作截图供制作。
- 分别在 Chrome 与 Edge 完成 README 人工验收清单。
- 在两家商店各上传 ZIP 并完成审核；当前 ZIP 不含 `update_url`。

图标：`assets/icon-128.png`。打包命令：`npm.cmd run package`。
