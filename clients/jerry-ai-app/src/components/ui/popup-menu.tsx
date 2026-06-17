/**
 * PopupMenu — 省略号下拉菜单组件
 *
 * 用于 FileCard 中将低频操作（删除）收纳到 ⋮ 按钮中。
 * 使用 React Portal 渲染到 body 以避免父容器 overflow:hidden 裁剪。
 * 自动检测视口边界，向上/下、左/右翻转，确保菜单不会超出屏幕。
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

export interface PopupMenuItem {
  /** 唯一标识 */
  id: string;
  /** 显示文字 */
  label: string;
  /** 左侧图标（可选） */
  icon?: React.ReactNode;
  /** 是否为危险操作（红色文字） */
  danger?: boolean;
  /** 点击回调 */
  onClick: () => void;
}

interface PopupMenuProps {
  items: PopupMenuItem[];
  /** 触发按钮的 aria-label */
  label?: string;
}

export function PopupMenu({ items, label = '更多操作' }: PopupMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  // 计算菜单定位，检测边界翻转
  const computePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const GAP = 4;
    const MENU_W = 160;
    const MENU_H = items.length * 40 + 8; // 每个菜单项 40px + padding

    let top = rect.bottom + GAP;
    let left = rect.right - MENU_W;

    // 向下翻转：底部不够
    if (top + MENU_H > window.innerHeight) {
      top = rect.top - MENU_H - GAP;
    }
    // 水平边界
    if (left < 4) left = 4;
    if (left + MENU_W > window.innerWidth - 4) {
      left = window.innerWidth - MENU_W - 4;
    }
    // 顶部不够
    if (top < 4) top = 4;

    setMenuStyle({
      position: 'fixed',
      top,
      left,
      zIndex: 9999,
      minWidth: MENU_W,
    });
  }, [items.length]);

  useEffect(() => {
    if (open) {
      computePosition();
      // close on outside click (排除 trigger 和 menu 自身)
      const handleClickOutside = (e: MouseEvent) => {
        const target = e.target as Node;
        if (
          triggerRef.current?.contains(target) ||
          menuRef.current?.contains(target)
        ) {
          return;
        }
        setOpen(false);
      };
      // close on Escape
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setOpen(false);
      };
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleKeyDown);
      };
    }
  }, [open, computePosition]);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen((prev) => !prev);
  }, []);

  const handleItemClick = useCallback((item: PopupMenuItem) => {
    setOpen(false);
    item.onClick();
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        className="inline-flex items-center justify-center p-1.5 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        title={label}
        aria-label={label}
        aria-expanded={open}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="rounded-lg border border-border bg-popover text-popover-foreground shadow-lg py-1"
            style={menuStyle}
            role="menu"
            aria-label={label}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                onClick={() => handleItemClick(item)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent ${
                  item.danger ? 'text-red-600 hover:text-red-700' : ''
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
