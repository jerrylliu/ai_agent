/**
 * DocumentUploadDialog - 文档上传对话框
 * 支持新建文档或为已有文档上传新版本
 */

import { useState, useRef } from 'react';
import { X, Upload, FileText, Loader2, Plus } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { uploadDocument, type DocumentItem } from '../../lib/api';

interface DocumentUploadDialogProps {
  documents: DocumentItem[];
  onSuccess: () => void;
  onClose: () => void;
}

export function DocumentUploadDialog({ documents, onSuccess, onClose }: DocumentUploadDialogProps) {
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [selectedDocId, setSelectedDocId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      setFile(selected);
      setError(null);
      // 新建模式自动填充标题
      if (mode === 'new' && !title) {
        setTitle(selected.name.replace(/\.[^/.]+$/, ''));
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0];
    if (dropped) {
      setFile(dropped);
      setError(null);
      if (mode === 'new' && !title) {
        setTitle(dropped.name.replace(/\.[^/.]+$/, ''));
      }
    }
  };

  const handleSubmit = async () => {
    if (!file) {
      setError('请选择文件');
      return;
    }
    if (mode === 'new' && !title.trim()) {
      setError('请输入文档标题');
      return;
    }
    if (mode === 'existing' && !selectedDocId) {
      setError('请选择目标文档');
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const tags = tagsInput
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);

      await uploadDocument(file, {
        documentId: mode === 'existing' ? selectedDocId! : undefined,
        title: mode === 'new' ? title : undefined,
        description: mode === 'new' ? description : undefined,
        tags: mode === 'new' && tags.length > 0 ? tags : undefined,
      });
      onSuccess();
    } catch (err: any) {
      setError(err.message || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-card rounded-xl shadow-2xl w-full max-w-lg border border-border">
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-semibold flex items-center gap-2">
            <Upload className="h-5 w-5" />
            上传文档
          </h3>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* 内容 */}
        <div className="p-4 space-y-4">
          {/* 模式切换 */}
          <div className="flex gap-2">
            <Button
              variant={mode === 'new' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('new')}
              className="flex-1"
            >
              <Plus className="h-4 w-4 mr-1" />
              新建文档
            </Button>
            <Button
              variant={mode === 'existing' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('existing')}
              className="flex-1"
            >
              <FileText className="h-4 w-4 mr-1" />
              新增版本
            </Button>
          </div>

          {/* 新建模式：文档信息 */}
          {mode === 'new' && (
            <div className="space-y-3">
              <div>
                <Label className="text-sm">文档标题</Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="输入文档标题"
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-sm">描述（可选）</Label>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="输入文档描述"
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-sm">标签（可选，逗号分隔）</Label>
                <Input
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder="如：技术文档, API, 教程"
                  className="mt-1"
                />
              </div>
            </div>
          )}

          {/* 已有文档模式：选择文档 */}
          {mode === 'existing' && (
            <div>
              <Label className="text-sm">选择目标文档</Label>
              <div className="mt-1 max-h-40 overflow-y-auto border rounded-lg">
                {documents.length === 0 ? (
                  <div className="p-3 text-center text-sm text-muted-foreground">暂无文档</div>
                ) : (
                  documents.map(doc => (
                    <div
                      key={doc.id}
                      className={`p-2.5 cursor-pointer border-b last:border-0 transition-colors ${
                        selectedDocId === doc.id
                          ? 'bg-primary/10'
                          : 'hover:bg-muted'
                      }`}
                      onClick={() => setSelectedDocId(doc.id)}
                    >
                      <div className="font-medium text-sm">{doc.title}</div>
                      {doc.description && (
                        <div className="text-xs text-muted-foreground truncate">{doc.description}</div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* 文件选择 */}
          <div>
            <Label className="text-sm">选择文件</Label>
            <div
              className="mt-1 border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFileSelect}
                accept=".txt,.md,.pdf,.doc,.docx,.csv,.json,.html"
              />
              {file ? (
                <div className="flex items-center justify-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  <div className="text-sm">
                    <span className="font-medium">{file.name}</span>
                    <span className="text-muted-foreground ml-2">({formatFileSize(file.size)})</span>
                  </div>
                </div>
              ) : (
                <div>
                  <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">点击选择文件或拖拽到此处</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    支持 TXT, MD, PDF, DOC, DOCX, CSV, JSON, HTML
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 p-2 rounded">
              {error}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <Button variant="outline" onClick={onClose} disabled={uploading}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={uploading || !file}>
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                上传中...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-1" />
                上传
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
