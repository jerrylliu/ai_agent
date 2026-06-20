/**
 * VersionTimeline - 版本时间线组件
 * 以时间线形式展示文档的所有版本，支持回滚、删除、归档、对比、下载操作
 */

import { useState } from 'react';
import {
  RotateCcw, Trash2, Archive, GitCompare, UploadCloud,
  CheckCircle, AlertCircle, Clock, Loader2, FileText,
  Download, Pencil, FileCode, FileType,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { PopupMenu, type PopupMenuItem } from '../ui/popup-menu';
import type { DocumentVersionItem } from '../../lib/api';

interface VersionTimelineProps {
  versions: DocumentVersionItem[];
  documentId: number;
  onRollback: (versionId: number) => void;
  onDelete: (versionId: number) => void;
  onArchive: (versionId: number) => void;
  onDiff: (v1: number, v2: number) => void;
  /** 发布到知识库（向量化 + 激活），DRAFT 和 ACTIVE 都可触发 */
  onPublish: (versionId: number) => void;
  /** 正在发布的版本 ID（用于 loading 状态） */
  publishingVersionId?: number | null;
  /** 导出版本到指定格式 */
  onExport: (versionId: number, format: 'md' | 'txt' | 'docx') => void;
}

export function VersionTimeline({
  versions,
  documentId,
  onRollback,
  onDelete,
  onArchive,
  onDiff,
  onPublish,
  publishingVersionId,
  onExport,
}: VersionTimelineProps) {
  const [selectedForDiff, setSelectedForDiff] = useState<number[]>([]);

  const toggleDiffSelect = (versionId: number) => {
    setSelectedForDiff(prev => {
      if (prev.includes(versionId)) {
        return prev.filter(id => id !== versionId);
      }
      if (prev.length >= 2) {
        return [prev[1], versionId];
      }
      return [...prev, versionId];
    });
  };

  const handleCompare = () => {
    if (selectedForDiff.length === 2) {
      onDiff(selectedForDiff[0], selectedForDiff[1]);
      setSelectedForDiff([]);
    }
  };

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      active: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
      draft: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
      archived: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    };
    return styles[status] || '';
  };

  const parsingIcon = (status: string) => {
    switch (status) {
      case 'success': return <CheckCircle className="h-3.5 w-3.5 text-green-500" />;
      case 'parsing': return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />;
      case 'failed': return <AlertCircle className="h-3.5 w-3.5 text-red-500" />;
      case 'pending': return <Clock className="h-3.5 w-3.5 text-yellow-500" />;
      default: return null;
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // 按版本号倒序排列
  const sortedVersions = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);

  return (
    <div>
      {/* 对比操作栏 */}
      {selectedForDiff.length > 0 && (
        <div className="mb-4 p-3 bg-muted rounded-lg flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            已选择 {selectedForDiff.length}/2 个版本进行对比
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedForDiff([])}
            >
              取消
            </Button>
            <Button
              size="sm"
              onClick={handleCompare}
              disabled={selectedForDiff.length < 2}
            >
              <GitCompare className="h-4 w-4 mr-1" />
              对比
            </Button>
          </div>
        </div>
      )}

      {sortedVersions.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          暂无版本记录
        </div>
      ) : (
        <div className="relative">
          {/* 时间线竖线 */}
          <div className="absolute left-5 top-0 bottom-0 w-0.5 bg-border" />

          <div className="space-y-4">
            {sortedVersions.map((version) => {
              const isSelected = selectedForDiff.includes(version.id);
              const isActive = version.status === 'active';

              // 构建省略号菜单项：编辑/下载(md/txt/docx)/归档/回滚/删除
              const menuItems: PopupMenuItem[] = [];

              // 编辑：跳转到编辑器（复用 onPublish 的发布能力，编辑入口由父组件控制）
              // 这里不加编辑按钮，编辑入口在文档卡片层面，版本时间线聚焦版本管理操作

              // 下载：三种格式
              menuItems.push(
                {
                  id: `download-md-${version.id}`,
                  label: '下载 Markdown',
                  icon: <FileCode className="h-3.5 w-3.5" />,
                  onClick: () => onExport(version.id, 'md'),
                },
                {
                  id: `download-txt-${version.id}`,
                  label: '下载纯文本',
                  icon: <FileText className="h-3.5 w-3.5" />,
                  onClick: () => onExport(version.id, 'txt'),
                },
                {
                  id: `download-docx-${version.id}`,
                  label: '下载 Word',
                  icon: <FileType className="h-3.5 w-3.5" />,
                  onClick: () => onExport(version.id, 'docx'),
                },
              );

              // 归档（ACTIVE 状态）
              if (version.status === 'active') {
                menuItems.push({
                  id: `archive-${version.id}`,
                  label: '归档',
                  icon: <Archive className="h-3.5 w-3.5" />,
                  onClick: () => onArchive(version.id),
                });
              }

              // 回滚（ARCHIVED 状态）
              if (version.status === 'archived') {
                menuItems.push({
                  id: `rollback-${version.id}`,
                  label: '回滚',
                  icon: <RotateCcw className="h-3.5 w-3.5" />,
                  onClick: () => onRollback(version.id),
                });
              }

              // 删除（非 ACTIVE 状态）
              if (version.status !== 'active') {
                menuItems.push({
                  id: `delete-${version.id}`,
                  label: '删除',
                  icon: <Trash2 className="h-3.5 w-3.5" />,
                  danger: true,
                  onClick: () => onDelete(version.id),
                });
              }

              return (
                <div key={version.id} className="relative pl-12">
                  {/* 时间线节点 */}
                  <div className={`absolute left-3 top-3 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                    isActive
                      ? 'border-green-500 bg-green-50 dark:bg-green-900/30'
                      : 'border-muted-foreground/30 bg-background'
                  }`}>
                    <div className={`w-2 h-2 rounded-full ${
                      isActive ? 'bg-green-500' : 'bg-muted-foreground/30'
                    }`} />
                  </div>

                  {/* 版本卡片 */}
                  <div className={`p-3 rounded-lg border transition-colors ${
                    isSelected
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/30'
                  }`}>
                    {/* 版本头部 */}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">v{version.versionNumber}</span>
                        <Badge className={`text-[10px] ${statusBadge(version.status)}`}>
                          {version.status}
                        </Badge>
                        <div className="flex items-center gap-1">
                          {parsingIcon(version.parsingStatus)}
                          <span className="text-[10px] text-muted-foreground">{version.parsingStatus}</span>
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(version.createdAt).toLocaleString()}
                      </span>
                    </div>

                    {/* 版本信息 */}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mb-2">
                      <span className="flex items-center gap-1">
                        <FileText className="h-3 w-3" />
                        {version.fileType}
                      </span>
                      <span>{formatFileSize(version.fileSize)}</span>
                      {version.checksum && (
                        <span title={version.checksum} className="truncate max-w-24">
                          {version.checksum.substring(0, 8)}...
                        </span>
                      )}
                    </div>

                    {/* 操作按钮 */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {/* 发布到知识库：DRAFT 显示"发布"，ACTIVE 显示"重新发布" */}
                      {version.status === 'draft' && (
                        <Button
                          variant="default"
                          size="xs"
                          onClick={() => onPublish(version.id)}
                          disabled={publishingVersionId === version.id}
                        >
                          <UploadCloud className="h-3 w-3 mr-1" />
                          {publishingVersionId === version.id ? '发布中...' : '发布到知识库'}
                        </Button>
                      )}
                      {version.status === 'active' && (
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => onPublish(version.id)}
                          disabled={publishingVersionId === version.id}
                        >
                          <UploadCloud className="h-3 w-3 mr-1" />
                          {publishingVersionId === version.id ? '重新发布中...' : '重新发布'}
                        </Button>
                      )}
                      {/* 对比选择 */}
                      <Button
                        variant={isSelected ? 'default' : 'ghost'}
                        size="xs"
                        onClick={() => toggleDiffSelect(version.id)}
                      >
                        <GitCompare className="h-3 w-3 mr-1" />
                        {isSelected ? '已选' : '对比'}
                      </Button>
                      {/* 省略号菜单：下载/归档/回滚/删除 */}
                      <PopupMenu items={menuItems} label="版本操作" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
