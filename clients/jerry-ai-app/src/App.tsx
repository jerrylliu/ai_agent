import "./new.css";
import ChatAgent from "./pages/ChatAgent";
import DocumentEditorPage from "./pages/DocumentEditorPage";
import { navigateToChat, useRoute } from "./lib/router";
import { useTheme } from "./hooks/useTheme";

function App() {
  // 确保主题在所有页面（包括独立编辑器窗口）都生效
  // ChatAgent 中也有 useTheme 调用用于主题切换 UI，两者不冲突：
  // 各自从 localStorage 读取相同初始值，只有用户主动切换时才会更新 documentElement
  useTheme();

  const route = useRoute();

  // 调试：打印当前 URL 信息
  if (typeof window !== 'undefined') {
    console.log('[App] location:', {
      href: window.location.href,
      hash: window.location.hash,
      pathname: window.location.pathname,
      search: window.location.search,
      route,
    });
  }

  return (
    <div className="h-full w-full">
      {route.name === 'editor' ? (
        <DocumentEditorPage
          documentId={route.documentId}
          standalone={route.standalone}
          onClose={navigateToChat}
        />
      ) : (
        <ChatAgent />
      )}
    </div>
  );
}

export default App;
