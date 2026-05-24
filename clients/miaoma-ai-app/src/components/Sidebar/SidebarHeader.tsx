
import {Search, Moon, Sun, Plus, Zap } from "lucide-react";
// ==================== UI 组件库 (shadcn/ui) ====================
// Button: 按钮组件，支持多种变体(default/ghost/outline等)和尺寸
// Input: 输入框组件，支持搜索、表单等场景
// Avatar/AvatarFallback/AvatarImage: 头像组件，显示用户/AI头像
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
interface SidebarHeaderProps {
    cycleTheme: () => void;
    theme: string;
    createNewSession: () => void;
    searchKeyword: string;
    setSearchKeyword: (keyword: string) => void;
}
const SidebarHeader: React.FC<SidebarHeaderProps> = ({ cycleTheme, theme, createNewSession, searchKeyword, setSearchKeyword }) => {
    return (
        <div className="p-4 border-b border-gray-200 dark:border-slate-600">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white cyberpunk-header-title">智能助手</h3>
                <Button variant="ghost" size="icon" onClick={cycleTheme} title={`当前：${theme === 'light' ? '白天' : theme === 'dark' ? '黑夜' : '赛博朋克'}，点击切换`}>
                    {theme === 'light' ? <Moon className="h-5 w-5" /> : theme === 'dark' ? <Zap className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
                </Button>
            </div>
            <div className="flex space-x-2 mb-4">
                <Button
                    onClick={createNewSession}
                    className="flex-1 bg-primary hover:bg-primary/90 text-white"
                >
                    <Plus className="h-4 w-4 mr-2" />
                    新对话
                </Button>
            </div>
            <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                    placeholder="搜索会话..."
                    className="pl-10"
                    value={searchKeyword}
                    onChange={(e) => setSearchKeyword(e.target.value)}
                />
            </div>
        </div>
    );
};

export default SidebarHeader;
