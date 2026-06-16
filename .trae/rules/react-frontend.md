# React 前端技术栈规范

> 作用域：`clients/jerry-ai-app/`  
> 关联：本规范在 `global.md` 基础上，针对 Tauri 2 + React 19 + TailwindCSS 4 + shadcn/ui 技术栈做细化约束。

---

## 1. 技术栈速查

| 类别 | 技术 | 版本 | 备注 |
|------|------|------|------|
| 桌面框架 | Tauri | 2.x | Rust 后端 |
| UI 框架 | React | 19.2.x | 函数组件 + Hooks |
| 语言 | TypeScript | 5.9.x | strict 模式 |
| 构建工具 | Vite | 8.x | @vitejs/plugin-react |
| CSS | TailwindCSS | 4.x | @tailwindcss/vite 插件 |
| 组件库 | shadcn/ui | new-york | Radix UI 底层 |
| 图标 | lucide-react | 1.x | - |
| 状态管理 | Zustand | 5.x | + persist 中间件 |
| 路由 | 无 | - | 单页面应用，无路由 |
| 虚拟列表 | @tanstack/react-virtual | 3.x | 聊天列表 |
| Markdown 渲染 | react-markdown | 10.x | + remark-gfm |
| 图表 | echarts-for-react | 3.x | - |
| 测试 | Vitest | 4.x | + Testing Library |

---

## 2. 组件架构规范

### 2.1 组件目录结构
```
src/
├── components/
│   ├── Chat/              # 聊天功能组件
│   │   ├── ChatBubble.tsx
│   │   ├── ChatInput.tsx
│   │   ├── MessageList.tsx
│   │   ├── index.ts       # 统一导出
│   │   └── ChatBubble.test.tsx
│   ├── Document/          # 文档管理组件
│   ├── KnowledgeSource/   # 知识源管理
│   ├── Settings/          # 设置组件
│   ├── Sidebar/           # 侧边栏
│   └── ui/                # shadcn/ui 基础组件
│       ├── button.tsx
│       ├── card.tsx
│       └── ...
├── hooks/                 # 自定义 Hooks
│   ├── useChat.ts
│   ├── useAuth.ts
│   └── useTheme.ts
├── stores/                # Zustand 全局状态
│   ├── settings-store.ts
│   ├── toast-store.ts
│   └── ui-store.ts
├── lib/                   # 工具库
│   ├── api.ts             # API 客户端
│   ├── constants.ts       # 常量
│   ├── utils.ts           # 工具函数
│   └── sse-parser.ts      # SSE 流解析
├── types/                 # 类型定义
│   └── session.ts
├── contexts/              # React Context
│   └── FavoriteDocContext.tsx
├── pages/
│   └── ChatAgent.tsx      # 主页面
└── App.tsx
```

### 2.2 组件分层
```
Page（ChatAgent.tsx）
  → 组合 Chat/Sidebar/Settings 等上层组件
  → 通过 Hooks 获取数据和操作
  → 不直接调用 API

Component（Chat/、Document/ 等）
  → 纯 UI 组件：通过 props 接收数据
  → 容器组件：调用 Hooks 获取数据，向下传递

Hooks（useChat.ts 等）
  → 封装 API 调用和状态管理逻辑
  → 通过 lib/api.ts 发送请求

Store（Zustand）
  → 全局/持久化状态（如设置、Token）
  → 不包含 React 概念
```

### 2.3 组件导出
- 每个组件目录必须有 `index.ts` 统一导出：
  ```typescript
  export { ChatBubble } from './ChatBubble';
  export { ChatInput } from './ChatInput';
  export { MessageList } from './MessageList';
  ```

---

## 3. 状态管理规范

### 3.1 Zustand Store 模式
```typescript
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface XxxState {
  value: string;
  setValue: (v: string) => void;
}

export const useXxxStore = create<XxxState>()(
  persist(
    (set) => ({
      value: 'default',
      setValue: (v) => set({ value: v }),
    }),
    {
      name: 'xxx-storage-key',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
```
- Store 命名：`useXxxStore`。
- 持久化 key 使用固定的 `name` 字段，避免冲突。
- **禁止**在 Store 的 set 函数中做异步操作。

### 3.2 Context 使用场景
- 仅在需要跨多层级组件传递且不适合放入 Store 时使用 Context（如 `FavoriteDocContext`）。
- **禁止**所有状态都放 Context，优先使用 Zustand。

---

## 4. API 调用规范

### 4.1 统一入口
- 所有 HTTP 请求通过 `src/lib/api.ts` 中的函数发起。
- **禁止**在组件或 Hook 中直接使用 `fetch()`。

### 4.2 API 函数模式
```typescript
// 正确示例（参考 lib/api.ts 现有模式）
export async function sendMessage(params: {
  message: string;
  sessionId: string;
  images?: string[];
}): Promise<Response> {
  const headers = getAuthHeaders();
  return fetch(`${API_BASE_URL}${API_ENDPOINTS.CHAT_PROMPT}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}
```
- 每个 API 函数必须声明返回类型。
- 错误处理使用 `handleResponse<T>()` 统一处理。

### 4.3 SSE 流解析
- SSE 流使用 `src/lib/sse-parser.ts` 中的 `parseSSEFrames` 和 `handleSSEEvents`。
- **禁止**在组件中手写 `eventSource.onmessage` 逻辑。

---

## 5. TailwindCSS 4 规范

### 5.1 样式编写
- **禁止**创建独立的 `.css` 文件（`src/new.css` 是唯一的全局样式入口）。
- 全部使用 Tailwind 原子类，在 `className` 中编写。
- CSS 变量定义在 `src/new.css` 中（shadcn/ui 的 new-york 风格）。

### 5.2 暗色模式
- 使用 `darkMode: 'class'`（在 `tailwind.config.js` 中配置）。
- 通过 `useTheme` Hook 控制 `html` 元素的 `class="dark"` 切换。
- 所有组件必须同时支持亮色/暗色模式，使用 `dark:` 前缀。

### 5.3 禁止的行为
- **禁止**使用内联 `style={{}}`（除非动态计算值无法用 Tailwind 表达，如 `width: ${percent}%`）。
- **禁止**引入其他 CSS 框架或原子化工具。

---

## 6. shadcn/ui 组件规范

### 6.1 组件使用
- 基础 UI 组件放在 `src/components/ui/` 下，由 shadcn CLI 管理。
- 自定义组件使用 shadcn 基础组件组合（如 `Dialog` 包装业务表单）。
- shadcn 的 `cn()` 函数（`clsx` + `tailwind-merge`）用于动态拼接 className。

### 6.2 组件配置
- shadcn 配置文件：`components.json`
  - 样式：`new-york`
  - 图标库：`lucide`
  - 路径别名：`@/` → `src/`
- **禁止**手动修改 `components.json`，添加组件使用 `npx shadcn@latest add <component>`。

---

## 7. React 19 规范

### 7.1 函数组件
- 全部使用函数组件，**禁止**使用 Class 组件。
- 组件 Props 必须有明确的 TypeScript 接口定义：
  ```typescript
  interface ChatBubbleProps {
    message: string;
    role: 'user' | 'assistant';
    timestamp?: number;
  }
  
  export function ChatBubble({ message, role, timestamp }: ChatBubbleProps) {
    // ...
  }
  ```

### 7.2 Hooks 使用
- 自定义 Hook 以 `use` 开头命名。
- 每个 Hook 只负责一个关注点。
- **禁止** 在条件语句中使用 Hooks（React 规则）。

### 7.3 性能
- 聊天消息列表使用 `@tanstack/react-virtual` 做虚拟滚动（已集成）。
- 避免在渲染路径中创建新对象/函数（能用 `useMemo`/`useCallback` 的场景要使用）。

---

## 8. Tauri 2 规范

### 8.1 Tauri API
- 使用 `@tauri-apps/api`（v2）调用 Tauri 原生能力。
- 文件系统操作使用 `@tauri-apps/plugin-fs`。
- 对话框使用 `@tauri-apps/plugin-dialog`。
- **禁止**在前端代码中直接 import `src-tauri/` 中的 Rust 模块。

### 8.2 开发端口
- Vite 开发服务器固定端口：**1420**。
- Tauri 开发命令：`pnpm tauri dev`。

---

## 9. 测试规范

### 9.1 单元测试
- 使用 Vitest + Testing Library。
- 测试文件命名：`*.test.ts` / `*.test.tsx`，与源文件同级。
- Hook 测试使用 `renderHook` from `@testing-library/react`。
- UI 组件测试使用 `render` + `screen` + `userEvent`。

### 9.2 测试 Setup
- 全局 setup：`src/test/setup.ts`。
- `vitest/globals` 已在 `tsconfig.json` 中启用，测试文件中可直接使用 `describe`、`it`、`expect`。

### 9.3 E2E 测试
- 推荐使用 **Playwright**（需要时安装）：`pnpm --filter jerry-ai-app add -D @playwright/test`。
- E2E 测试覆盖核心流程：打开应用 → 输入消息 → 收到 AI 回复 → 查看历史会话。
- **原因**：Tauri 桌面应用的上线前必须有 E2E 验证，WebView 中的交互无法通过单元测试覆盖。

---

## 10. 配置依赖清单

以下为本项目**已安装**的关键前端依赖，AI 生成代码时只能使用这些包：

| 用途 | 包名 | 版本 |
|------|------|------|
| UI 框架 | `react`, `react-dom` | ^19.2.x |
| 桌面 | `@tauri-apps/api`, `@tauri-apps/cli` | ^2.x |
| 状态管理 | `zustand` | ^5.x |
| CSS | `tailwindcss` | ^4.x |
| Tailwind 合并 | `tailwind-merge`, `clsx` | - |
| 动画 CSS | `tw-animate-css` | ^1.x |
| UI 组件 (shadcn) | `@radix-ui/react-*`, `lucide-react`, `class-variance-authority` | - |
| 虚拟列表 | `@tanstack/react-virtual` | ^3.x |
| Markdown | `react-markdown`, `remark-gfm`, `react-syntax-highlighter` | - |
| 图表 | `echarts`, `echarts-for-react` | ^6.x / ^3.x |
| 文档预览 | `docx-preview` | ^0.3.x |
| 面板 | `react-resizable-panels` | ^4.x |
| 测试 | `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom` | ^4.x |

**禁止**自动引入上述列表之外的 UI 库或工具库。
