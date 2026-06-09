import { useState, useRef, useEffect } from "react";
import { Search, Plus, PanelLeftClose } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

interface SidebarHeaderProps {
    createNewSession: () => void;
    searchKeyword: string;
    setSearchKeyword: (keyword: string) => void;
    onToggleSidebar: () => void;
}

const SidebarHeader: React.FC<SidebarHeaderProps> = ({ createNewSession, searchKeyword, setSearchKeyword, onToggleSidebar }) => {
    const [showSearch, setShowSearch] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (showSearch && searchInputRef.current) {
            searchInputRef.current.focus();
        }
    }, [showSearch]);

    return (
        <div className="p-3  dark:border-slate-600">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white cyberpunk-header-title">以太忆核</h3>
                <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" onClick={() => setShowSearch(!showSearch)} title="搜索会话">
                        <Search className="h-5 w-5" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={onToggleSidebar} title="收起侧边栏">
                        <PanelLeftClose className="h-5 w-5" />
                    </Button>
                </div>
            </div>

            {/* 搜索弹框 */}
            {showSearch && (
                <div className="mb-4 relative">
                    <div className="bg-card border border-border rounded-lg shadow-lg p-3">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                ref={searchInputRef}
                                placeholder="搜索会话..."
                                className="pl-10"
                                value={searchKeyword}
                                onChange={(e) => setSearchKeyword(e.target.value)}
                            />
                        </div>
                        {searchKeyword && (
                            <button
                                className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                                onClick={() => { setSearchKeyword(""); setShowSearch(false); }}
                            >
                                清除搜索
                            </button>
                        )}
                    </div>
                </div>
            )}

            <div className="flex space-x-2">
                <Button
                    onClick={createNewSession}
                    className="flex-1 bg-primary hover:bg-primary/90 text-white"
                >
                    <Plus className="h-4 w-4 mr-2" />
                    新对话
                </Button>
            </div>
        </div>
    );
};

export default SidebarHeader;
