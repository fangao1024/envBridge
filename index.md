# EnvBridge 浏览器扩展需求文档

## 1. 项目基本信息

### 1.1 产品名称

**EnvBridge**

英文全称建议：

**EnvBridge - Browser Environment State Bridge**

中文名称建议：

**EnvBridge - 浏览器环境状态迁移工具**

### 1.2 产品定位

EnvBridge 是一款面向前端开发者、测试工程师及研发团队的浏览器扩展，用于在不同 Origin / 域名 / 开发环境之间迁移浏览器本地状态。

典型场景：

```text
生产环境
https://www.example.com

        ↓

开发环境
http://www.dev.com:3000
```

EnvBridge 可以将源环境中的：

- Cookie
- localStorage
- sessionStorage
- IndexedDB

迁移到目标环境，并根据目标环境的域名、协议和 Origin 自动处理兼容性。

产品核心并不是简单的“复制”，而是：

```text
读取
  ↓
转换
  ↓
兼容性校验
  ↓
写入目标环境
```

即：

**Transfer + Rewrite + Clone**

---

# 2. 项目背景

日常前端开发过程中，经常存在以下环境：

```text
Production
Staging
Test
Development
Local
```

例如：

```text
https://www.example.com
https://test.example.com
http://www.dev.com
http://localhost:3000
```

不同环境拥有完全独立的浏览器存储空间。

开发者经常需要重新：

- 登录
- 设置用户状态
- 设置本地配置
- 创建测试数据
- 初始化 IndexedDB
- 写入 localStorage
- 配置 Cookie

目前浏览器本身没有提供跨域迁移这些数据的能力。

普通网页 JavaScript 又受到浏览器同源策略限制：

```text
www.example.com
```

页面无法直接操作：

```text
www.dev.com
```

的 Cookie、localStorage、IndexedDB。

浏览器扩展拥有更高权限，因此可以作为两个 Origin 之间的桥梁。

EnvBridge 的目标就是解决这一问题。

---

# 3. 产品目标

EnvBridge 需要实现：

```text
Source Origin
      ↓
   EnvBridge
      ↓
Target Origin
```

允许用户选择源环境和目标环境，并快速迁移浏览器状态。

核心目标：

1. 支持不同域名之间的数据迁移。
2. 支持 Cookie Domain 自动重写。
3. 支持 localStorage 跨 Origin 复制。
4. 支持 sessionStorage 跨 Tab / Origin 复制。
5. 支持 IndexedDB 完整迁移。
6. 支持迁移前预览。
7. 支持选择具体数据项。
8. 支持保存常用环境映射。
9. 支持一键迁移。
10. 支持迁移错误提示和兼容性检查。
11. 后续支持 Chrome Web Store。
12. 后续支持 Microsoft Edge Add-ons。

---

# 4. 目标用户

主要用户：

### 前端开发者

用于：

```text
线上 → 本地
测试 → 本地
预发布 → 本地
```

快速复现用户状态。

### 测试工程师

快速将：

```text
测试账号 A
测试账号 B
测试环境状态
```

复制到指定环境。

### 全栈开发者

快速迁移：

- 登录态
- Feature Flag
- IndexedDB
- 用户偏好
- 草稿数据
- 本地缓存

### 企业研发团队

用于统一：

```text
Production
Staging
QA
Local
```

之间的浏览器环境切换。

---

# 5. 第一阶段 MVP

第一版本必须实现以下四类数据：

```text
Cookies
localStorage
sessionStorage
IndexedDB
```

同时提供：

```text
[ Clone Cookies ]

[ Clone localStorage ]

[ Clone sessionStorage ]

[ Clone IndexedDB ]

[ Clone All ]
```

---

# 6. 页面结构

扩展 Popup 主页面建议结构：

```text
┌────────────────────────────┐
│ EnvBridge                  │
│ Browser State Bridge       │
├────────────────────────────┤
│                            │
│ SOURCE                     │
│ https://www.example.com    │
│                            │
│            ↓               │
│                            │
│ TARGET                     │
│ http://www.dev.com:3000    │
│                            │
├────────────────────────────┤
│ ☑ Cookies             12   │
│ ☑ localStorage        18   │
│ ☑ sessionStorage       4   │
│ ☑ IndexedDB            3   │
├────────────────────────────┤
│                            │
│      Preview Changes       │
│                            │
│      Clone All             │
│                            │
└────────────────────────────┘
```

---

# 7. Source 和 Target

## 7.1 Source

Source 表示数据来源 Origin。

例如：

```text
https://www.example.com
```

支持以下选择方式：

### 当前 Tab

```text
Use Current Tab
```

自动读取当前浏览器 Tab：

```ts
tab.url;
```

并计算：

```ts
new URL(tab.url).origin;
```

### 已打开 Tab

展示当前浏览器中可操作的 Tab：

```text
www.example.com
test.example.com
www.dev.com:3000
localhost:3000
```

用户可以直接选择。

### 手动输入

允许输入：

```text
https://www.example.com
```

---

# 8. Target

Target 为数据迁移目标。

例如：

```text
http://www.dev.com:3000
```

目标必须是浏览器当前已打开或扩展拥有 Host Permission 的 Origin。

优先提供：

```text
Current Tabs
```

供用户选择。

---

# 9. Origin 显示规范

统一使用：

```text
protocol://hostname:port
```

例如：

```text
https://www.example.com
http://www.dev.com:3000
http://localhost:3000
```

不要只显示：

```text
www.dev.com
```

因为：

```text
http://localhost:3000
http://localhost:3001
```

属于不同 Origin。

---

# 10. Cookie 功能

Cookie 是 EnvBridge 的核心功能之一。

## 10.1 读取 Cookie

使用浏览器 Extension Cookie API。

需要读取：

```ts
interface EnvBridgeCookie {
  name: string;
  value: string;

  domain: string;
  path: string;

  secure: boolean;
  httpOnly: boolean;

  sameSite?: chrome.cookies.SameSiteStatus;

  expirationDate?: number;

  session: boolean;
  hostOnly: boolean;

  storeId?: string;
}
```

---

# 11. Cookie 迁移模式

提供两个模式。

## Preserve Mode

保留 Cookie 原始属性。

```text
Domain=.example.com
```

复制时尽量保持：

```text
Domain=.example.com
```

适合：

```text
www.example.com
        ↓
test.example.com
```

---

## Rewrite Mode

默认推荐该模式。

自动根据 Target 修改 Cookie。

例如：

```text
Source

https://www.example.com
```

Cookie：

```text
token=abc123
Domain=.example.com
Secure=true
```

Target：

```text
http://www.dev.com
```

转换为：

```text
token=abc123
Domain=www.dev.com
Secure=false
```

---

# 12. Cookie Rewrite Engine

需要独立实现：

```ts
rewriteCookie(cookie, sourceOrigin, targetOrigin);
```

核心转换内容：

```text
domain
secure
sameSite
path
url
```

---

# 13. Domain Rewrite

例如：

```text
.example.com
```

迁移到：

```text
www.dev.com
```

转换：

```text
.example.com
        ↓
www.dev.com
```

如果目标：

```text
http://localhost:3000
```

建议使用 host-only Cookie。

---

# 14. Secure 处理

如果：

```text
Target = http://
```

而：

```text
secure = true
```

需要提示：

```text
Secure Cookie cannot be used normally on this target.
```

允许 EnvBridge 根据兼容模式决定：

```text
secure: false
```

但必须显示转换结果。

---

# 15. SameSite 处理

需要检查：

```text
Strict
Lax
None
Unspecified
```

尤其：

```text
SameSite=None
```

通常需要与：

```text
Secure=true
```

配合。

如果目标环境无法满足，应显示：

```text
Compatibility Warning
```

---

# 16. 特殊 Cookie

需要识别：

```text
__Host-
__Secure-
```

例如：

```text
__Host-token
```

不能简单修改 Domain。

这类 Cookie 在 Preview 中标记：

```text
⚠ Special Cookie
```

并说明无法直接迁移或需要调整属性。

---

# 17. Cookie Preview

点击：

```text
Preview
```

展示：

```text
token

Source:
Domain=.example.com
Secure=true
SameSite=Lax

Target:
Domain=www.dev.com
Secure=false
SameSite=Lax
```

变化字段：

```text
Domain     Modified
Secure     Modified
```

---

# 18. localStorage

## 18.1 读取

读取：

```ts
localStorage;
```

转换为：

```ts
interface StorageItem {
  key: string;
  value: string;
}
```

---

# 19. localStorage 选择

展示：

```text
localStorage

☑ token
☑ userInfo
☐ theme
☐ searchHistory
☐ aiDraft
```

操作：

```text
Select All
Select None
Clone Selected
```

---

# 20. localStorage 写入策略

提供三种模式：

```text
Merge
Overwrite
Clear & Clone
```

### Merge

仅覆盖同名 Key。

不删除目标已有其他 Key。

推荐作为默认模式。

### Overwrite

源 Key 覆盖目标同名 Key。

实际上行为与 Merge 相近，但未来可增加类型策略。

### Clear & Clone

执行：

```ts
localStorage.clear();
```

然后重新写入。

该操作必须显示确认提示。

---

# 21. sessionStorage

sessionStorage 与 Tab 生命周期绑定。

EnvBridge 需要基于：

```text
Source Tab
Target Tab
```

进行复制。

流程：

```text
Source Tab
   ↓
读取 sessionStorage
   ↓
EnvBridge
   ↓
Target Tab
   ↓
写入 sessionStorage
```

完成后建议提供：

```text
Reload Target Tab
```

---

# 22. IndexedDB

IndexedDB 是 EnvBridge 与大量同类扩展拉开差异的核心功能。

不能只复制 Records。

需要完整迁移：

```text
Database
  ↓
Version
  ↓
ObjectStore
  ↓
Indexes
  ↓
Records
```

---

# 23. IndexedDB 数据结构

建议内部统一表示为：

```ts
interface IndexedDBSnapshot {
  name: string;
  version: number;

  stores: IndexedDBStore[];
}
```

Object Store：

```ts
interface IndexedDBStore {
  name: string;

  keyPath: string | string[] | null;

  autoIncrement: boolean;

  indexes: IndexedDBIndex[];

  records: IndexedDBRecord[];
}
```

Index：

```ts
interface IndexedDBIndex {
  name: string;

  keyPath: string | string[];

  unique: boolean;

  multiEntry: boolean;
}
```

---

# 24. IndexedDB Clone

例如：

```text
Source

app_database
Version 4

ObjectStore
users
drafts
settings
```

复制到：

```text
Target
```

目标不存在：

```text
app_database
```

则创建。

目标已经存在则提供：

```text
Merge
Replace Database
Cancel
```

---

# 25. Replace Database

如果选择：

```text
Replace Database
```

执行：

```text
deleteDatabase
      ↓
createDatabase
      ↓
createObjectStore
      ↓
createIndexes
      ↓
insertRecords
```

需要显示危险操作提示。

---

# 26. IndexedDB Preview

展示：

```text
IndexedDB

app_database

3 Object Stores
12 Indexes
1,426 Records
3.4 MB
```

展开：

```text
users
  128 records

drafts
  1248 records

settings
  50 records
```

---

# 27. Clone All

主按钮：

```text
Clone All
```

执行：

```text
Cookies
   ↓
localStorage
   ↓
sessionStorage
   ↓
IndexedDB
```

每一步单独显示状态：

```text
Cookies          ✓
localStorage     ✓
sessionStorage   ✓
IndexedDB        ...
```

最终：

```text
Clone completed

Cookies        12
localStorage   18
sessionStorage 4
IndexedDB      1426 records
```

---

# 28. 数据选择

支持每类数据独立开启：

```text
☑ Cookies
☑ localStorage
☑ sessionStorage
☑ IndexedDB
```

同时支持内部选择。

例如：

```text
Cookies

☑ token
☑ userid
☐ analytics_id
☐ AB_TEST
```

---

# 29. Preview Changes

同步之前提供：

```text
Preview Changes
```

建议提供 Diff。

状态：

```text
+ Add
~ Modify
= Same
- Remove
⚠ Warning
```

例如：

```text
~ Cookie token

Domain
.example.com
→
www.dev.com
```

---

# 30. Environment Preset

允许保存 Source / Target。

例如：

```text
51miz Local

Source
https://www.51miz.com

Target
http://www.dev.com:3002
```

之后主页显示：

```text
51miz Local       Clone

51miz QA          Clone

Editor Local      Clone
```

---

# 31. Preset 数据结构

```ts
interface EnvironmentPreset {
  id: string;

  name: string;

  sourceOrigin: string;
  targetOrigin: string;

  types: {
    cookies: boolean;
    localStorage: boolean;
    sessionStorage: boolean;
    indexedDB: boolean;
  };

  createdAt: number;
  updatedAt: number;
}
```

---

# 32. 自动刷新

迁移完成后提供：

```text
☑ Reload target page after clone
```

如果开启：

```ts
chrome.tabs.reload(targetTabId);
```

---

# 33. Backup

第二阶段建议增加。

每次迁移目标环境之前，自动保存目标状态。

```text
Backup

www.dev.com

2026-09-28 17:30
```

---

# 34. Rollback

允许：

```text
Restore
```

恢复迁移前：

```text
Cookies
Storage
IndexedDB
```

---

# 35. Cache Storage

第二阶段功能。

支持：

```text
Cache Storage
```

例如：

```text
workbox-precache
next-data
runtime-cache
```

需要复制：

```text
Request
Response
Headers
Body
```

---

# 36. Import / Export

第二阶段支持：

```text
Export Environment
```

导出：

```text
.envbridge
```

本质可以使用：

```json
{
  "version": 1,
  "cookies": [],
  "localStorage": [],
  "sessionStorage": [],
  "indexedDB": []
}
```

---

# 37. 安全设计

EnvBridge 会处理：

```text
Cookie
Authentication State
User Token
IndexedDB
Local Data
```

这些都可能包含敏感数据。

因此默认遵循：

```text
Local First
```

即：

**所有数据只在用户浏览器本地处理。**

默认：

```text
不上传服务器
不收集 Cookie
不收集 Token
不记录 Storage 内容
不记录 IndexedDB 内容
```

---

# 38. 禁止远程保存 Cookie

EnvBridge 不允许默认将：

```text
Cookie
localStorage
sessionStorage
IndexedDB
```

发送到 EnvBridge 服务端。

如果未来增加 Cloud Sync，应作为独立功能并明确征得用户授权。

---

# 39. 权限设计

Manifest V3。

建议最小权限原则。

可能需要：

```json
{
  "permissions": ["cookies", "storage", "tabs", "scripting"]
}
```

Host Permission 应谨慎设计。

不建议第一版直接永久请求：

```text
<all_urls>
```

更推荐根据功能研究：

```text
optional_host_permissions
```

在用户主动选择网站时申请权限。

这样：

```text
用户选择 Origin
        ↓
请求 Host Permission
        ↓
用户授权
        ↓
执行迁移
```

可以降低商店审核和用户信任成本。

---

# 40. 推荐 Manifest

初始设计：

```json
{
  "manifest_version": 3,

  "name": "EnvBridge",

  "version": "1.0.0",

  "description": "Clone browser state between development environments.",

  "permissions": ["cookies", "storage", "tabs", "scripting"],

  "optional_host_permissions": ["http://*/*", "https://*/*"],

  "background": {
    "service_worker": "background.js"
  },

  "action": {
    "default_popup": "popup.html"
  }
}
```

最终权限应以真实实现为准，未使用权限必须删除。

---

# 41. Chrome Web Store 上架要求

项目从第一版就需要考虑商店审核。

Chrome Web Store 版本应：

```text
Manifest V3
```

设计原则：

```text
Single Purpose
Minimum Permissions
Clear Privacy Disclosure
No Remote Code
No Hidden Behavior
```

EnvBridge 的 Single Purpose 定义：

> Clone browser storage and state between user-selected development environments.

不要在插件中混入：

```text
广告
抓包
代理
密码管理
网络扫描
网页自动化
```

等不相关能力。

---

# 42. Edge Add-ons

Edge 基于 Chromium。

EnvBridge 应尽量保持：

```text
Chrome Extension
      =
Edge Extension
```

共用：

```text
manifest.json
background
content scripts
popup
options
core logic
```

Edge 官方说明大多数 Chrome 扩展可以用很少修改移植到 Edge，但仍应检查实际使用的 API 是否被 Edge 支持。

发布 Edge 版本时还应注意：

```text
update_url
```

等 Chrome 特有配置，必要时移除。

---

# 43. 商店审核准备

需要提前准备：

```text
Extension Name

Short Description

Full Description

Logo

Screenshots

Privacy Policy

Support URL

Website

Permission Explanation
```

Edge 官方政策要求扩展用途清晰、权限只申请实际需要的范围，并对用户数据处理方式做清晰说明。

---

# 44. Privacy Policy

EnvBridge 必须提供隐私政策。

核心声明：

```text
EnvBridge processes browser storage locally.

EnvBridge does not upload,
store,
sell,
or share
Cookie,
localStorage,
sessionStorage,
or IndexedDB data.
```

中文：

```text
EnvBridge 的浏览器存储迁移操作均在用户设备本地完成。

EnvBridge 不会上传、保存、出售或共享用户的 Cookie、
localStorage、sessionStorage 或 IndexedDB 数据。
```

---

# 45. Permission Explanation

例如：

## cookies

用于：

```text
读取用户选择的 Source Origin Cookie

并写入用户选择的 Target Origin。
```

## scripting

用于：

```text
在用户主动选择的页面读取及写入 Web Storage / IndexedDB。
```

## tabs

用于：

```text
获取 Source / Target 页面以及 Origin。
```

## storage

用于保存：

```text
Environment Presets
Plugin Settings
```

不得用于云端记录用户网页数据。

---

# 46. 错误处理

错误类型统一：

```ts
enum EnvBridgeErrorCode {
  PERMISSION_DENIED,
  SOURCE_TAB_NOT_FOUND,
  TARGET_TAB_NOT_FOUND,

  COOKIE_WRITE_FAILED,

  STORAGE_READ_FAILED,
  STORAGE_WRITE_FAILED,

  INDEXED_DB_READ_FAILED,
  INDEXED_DB_WRITE_FAILED,

  INDEXED_DB_BLOCKED,

  UNSUPPORTED_COOKIE,

  INVALID_ORIGIN,

  UNKNOWN_ERROR,
}
```

---

# 47. 错误 UI

例如：

```text
Cookie Clone Failed

token

Reason:
Target uses HTTP but cookie requires Secure.

[ Skip ]
[ View Details ]
```

---

# 48. 日志

只记录执行信息。

例如：

```text
17:21:01 Start Clone

17:21:01 Cookie 12 detected

17:21:02 Cookie 11 success

17:21:02 Cookie 1 skipped

17:21:03 localStorage 18 success

17:21:06 IndexedDB 1426 records success

17:21:06 Complete
```

严禁日志记录：

```text
Cookie Value
Token Value
Authorization Value
```

---

# 49. 性能要求

localStorage：

```text
< 1000 items
```

应该接近即时完成。

Cookie：

```text
< 500 Cookies
```

应在合理时间内完成。

IndexedDB：

针对大量 Records：

```text
100
1,000
10,000
100,000
```

采用批处理。

例如：

```ts
const BATCH_SIZE = 500;
```

避免长时间阻塞页面。

---

# 50. IndexedDB 大数据提示

例如：

```text
Database size: 386 MB

Records: 135,842
```

弹窗：

```text
Large IndexedDB detected.

Clone may consume significant memory.

Continue?
```

---

# 51. 数据大小限制

EnvBridge 不应人为设置非常小的限制。

但应该提供：

```text
Item Count
Estimated Size
```

例如：

```text
IndexedDB

3 Databases

24 Stores

18,425 Records

Estimated Size:
82 MB
```

---

# 52. 技术架构

建议：

```text
Popup UI
   │
   ▼
Service Worker
   │
   ├── Cookie Service
   │
   ├── Permission Service
   │
   ├── Preset Service
   │
   ▼
Content Script
   │
   ├── LocalStorage Adapter
   │
   ├── SessionStorage Adapter
   │
   └── IndexedDB Adapter
```

---

# 53. Core 模块

建议：

```text
src/

core/

cookie/
  reader.ts
  writer.ts
  rewrite.ts

storage/
  local-storage.ts
  session-storage.ts

indexed-db/
  reader.ts
  writer.ts
  serializer.ts

environment/
  origin.ts
  preset.ts

permissions/
  permission.ts
```

---

# 54. Adapter 设计

统一接口：

```ts
interface StorageAdapter<T> {
  read(): Promise<T>;

  preview(source: T, target: T): Promise<DiffResult>;

  write(data: T, options?: CloneOptions): Promise<CloneResult>;
}
```

实现：

```text
CookieAdapter

LocalStorageAdapter

SessionStorageAdapter

IndexedDBAdapter
```

---

# 55. Clone Pipeline

统一流程：

```text
Permission Check
        ↓
Read Source
        ↓
Read Target
        ↓
Normalize
        ↓
Rewrite
        ↓
Diff
        ↓
User Confirm
        ↓
Backup
        ↓
Write
        ↓
Verify
        ↓
Reload
```

---

# 56. Verify

写入完成以后重新读取目标。

例如：

```text
Expected:
18 localStorage items

Actual:
18
```

结果：

```text
Verified
```

Cookie 同样：

```text
Expected 12
Actual 11

1 skipped
```

---

# 57. UI 页面

建议至少包含：

```text
Popup

Environment Presets

Clone Preview

Clone Result

Settings

About
```

---

# 58. Settings

第一版：

```text
Default Cookie Mode

○ Preserve
● Rewrite

Default Storage Mode

● Merge
○ Clear & Clone

☑ Reload Target After Clone

☑ Show Preview Before Clone
```

---

# 59. About

展示：

```text
EnvBridge

Version 1.0.0

Browser Environment State Bridge

GitHub

Privacy Policy

Report Issue
```

---

# 60. 第一版不做

为了控制 MVP 范围：

```text
Cloud Sync

Account System

Team Workspace

Remote Server

Cache Storage

Service Worker Clone

Extension Storage Clone

File System Access

WebSQL

Network Request Clone
```

均不进入 1.0。

---

# 61. V1.0 Feature Scope

最终 V1.0：

```text
✓ Different Origin

✓ Cookie Clone

✓ Cookie Domain Rewrite

✓ Cookie Compatibility Check

✓ localStorage Clone

✓ sessionStorage Clone

✓ IndexedDB Clone

✓ Select Individual Items

✓ Source Tab

✓ Target Tab

✓ Environment Preset

✓ Preview

✓ Clone All

✓ Reload Target

✓ Error Report

✓ Chrome

✓ Edge
```

---

# 62. V1.1

计划：

```text
Backup

Rollback

Import

Export

Clone History
```

---

# 63. V1.2

计划：

```text
Cache Storage

Advanced Diff

Ignore Rules

Key Filter
```

---

# 64. V2.0

考虑：

```text
Environment Snapshot

Team Profiles

Encrypted Environment Export

CLI

DevTools Integration
```

---

# 65. 产品核心竞争力

EnvBridge 不定位为：

```text
Cookie Manager
```

也不定位为：

```text
Storage Viewer
```

而是：

```text
Browser Environment Migration Tool
```

核心差异：

### 跨 Origin

```text
Production
↓
Local
```

### Rewrite

不是简单 Copy。

而是：

```text
Copy
+
Origin Rewrite
+
Compatibility Fix
```

### IndexedDB

完整复制：

```text
Database
Schema
Index
Records
```

### Preset

长期保存：

```text
Production → Local

Staging → Local

Production → QA
```

### Clone All

一次操作完成整个开发环境迁移。

---

# 66. 产品 Slogan

推荐：

```text
Bridge your browser environments.
```

或者：

```text
Clone browser state between environments.
```

或者：

```text
Move browser state. Keep coding.
```

中文：

```text
让开发环境无缝连接。
```

---

# 67. Chrome Store Description

短描述建议：

```text
Clone cookies, Web Storage and IndexedDB between development environments.
```

完整定位：

```text
EnvBridge helps developers clone browser state between production,
staging, testing and local development environments.

Move cookies, localStorage, sessionStorage and IndexedDB between
different origins with automatic compatibility handling.
```

---

# 68. 项目最终目标

用户只需要：

```text
打开线上页面

打开本地页面

打开 EnvBridge

选择：

Source
Production

Target
Local

点击：

Clone All
```

即可完成：

```text
Cookie
localStorage
sessionStorage
IndexedDB
```

完整环境迁移。

最终实现：

```text
Production
      ↓
   EnvBridge
      ↓
Local Development
```

让开发者不再需要：

```text
重复登录

手动 Copy Cookie

手动修改 localStorage

手动构造 IndexedDB

反复初始化开发环境
```

EnvBridge 最核心的一句话：

> **Clone the browser state, not the setup process.**
