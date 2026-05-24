import React from "react";
import { Upload, LogOut, LogIn, Settings } from "lucide-react";
import { Button } from "../ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { UserInfo } from "@/lib/api";
interface UserProfileProps {
  isAuthenticated: boolean;
  user: UserInfo | null;
  avatarUploading: boolean;
  avatarInputRef: React.RefObject<HTMLInputElement | null>;
  onAvatarUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onLogout: () => void;
  onOpenSettings: () => void;
  onShowAuthDialog: () => void;
}
const UserProfile: React.FC<UserProfileProps> =({isAuthenticated, user, avatarUploading, avatarInputRef, onAvatarUpload, onLogout, onOpenSettings, onShowAuthDialog}) =>{
return (<div className="flex-shrink-0 border-t border-gray-200 dark:border-slate-600 p-4">
    {isAuthenticated && user ? (
        <>
            {/* 已登录状态：用户头像、信息、操作按钮 */}
            <div className="flex items-center space-x-3">
                {/* 头像上传区域：点击触发文件选择，悬停显示上传图标 */}
                <div className="relative group cursor-pointer" onClick={() => !avatarUploading && avatarInputRef.current?.click()}>
                    <Avatar className={`h-10 w-10 transition-opacity ${avatarUploading ? 'opacity-50' : ''}`}>
                        <AvatarImage src={user.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.username || user.id}`} />
                        <AvatarFallback>{(user.username || user.email || '用户')[0].toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
                        <Upload className="h-4 w-4 text-white" />
                    </div>
                    <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 border-2 border-white dark:border-slate-800 rounded-full"></div>
                    <input
                        ref={avatarInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/gif,image/webp"
                        className="hidden"
                        onChange={onAvatarUpload}
                    />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white truncate cyberpunk-username">{user.username || user.email || user.phone || '用户'}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-300 truncate cyberpunk-useremail">{user.email || user.phone || '在线'}</p>
                </div>
                <div className="flex items-center space-x-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onOpenSettings()} title="设置">
                        <Settings className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onLogout()} title="退出登录">
                        <LogOut className="h-4 w-4 text-gray-500" />
                    </Button>
                </div>
            </div>
        </>
    ) : (
        <>
            {/* 未登录状态：默认头像、登录提示、操作按钮 */}
            <div className="flex items-center space-x-3">
                {/* 默认头像占位 */}
                <div className="relative">
                    <Avatar className="h-10 w-10">
                        <AvatarFallback>?</AvatarFallback>
                    </Avatar>
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white cyberpunk-unauth">未登录</p>
                    <p className="text-xs text-gray-500 dark:text-gray-300 cyberpunk-unauth">点击设置登录账号</p>
                </div>
                <div className="flex items-center space-x-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onOpenSettings()} title="设置">
                        <Settings className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onShowAuthDialog()} title="登录/注册">
                        <LogIn className="h-4 w-4 text-gray-500" />
                    </Button>
                </div>
            </div>
        </>
    )}
</div>
)}
export default UserProfile;
