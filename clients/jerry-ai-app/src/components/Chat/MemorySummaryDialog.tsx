import React, { useState, useEffect } from 'react';
import { X, Brain, FileText, Trash2, RefreshCw, Plus, Loader2, Pencil, Check } from 'lucide-react';
import { Button } from '../ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import {
  getUserMemories,
  deleteUserMemory,
  addUserMemory,
  updateUserMemory,
  getSessionSummary,
  generateSessionSummary,
  type UserMemoryData,
  type SessionSummaryData,
} from '../../lib/api';

interface MemorySummaryDialogProps {
  open: boolean;
  onClose: () => void;
  currentSessionId: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  preference: '偏好',
  fact: '事实',
  decision: '决策',
  context: '上下文',
  skill: '技能',
};

const CATEGORY_COLORS: Record<string, string> = {
  preference: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  fact: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  decision: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  context: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  skill: 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
};

const MemorySummaryDialog: React.FC<MemorySummaryDialogProps> = ({ open, onClose, currentSessionId }) => {
  const [memories, setMemories] = useState<UserMemoryData[]>([]);
  const [summary, setSummary] = useState<SessionSummaryData | null>(null);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newMemoryContent, setNewMemoryContent] = useState('');
  const [newMemoryCategory, setNewMemoryCategory] = useState('fact');
  const [addingMemory, setAddingMemory] = useState(false);

  // 编辑状态
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // 加载记忆列表
  const loadMemories = async () => {
    setMemoriesLoading(true);
    try {
      const res = await getUserMemories();
      setMemories(res.memories);
    } catch (error) {
      console.error('加载记忆失败:', error);
    } finally {
      setMemoriesLoading(false);
    }
  };

  // 加载当前会话摘要
  const loadSummary = async () => {
    if (!currentSessionId) return;
    setSummaryLoading(true);
    try {
      const data = await getSessionSummary(currentSessionId);
      setSummary(data);
    } catch (error) {
      console.error('加载摘要失败:', error);
    } finally {
      setSummaryLoading(false);
    }
  };

  // 刷新全部
  const handleRefresh = async () => {
    await Promise.all([loadMemories(), loadSummary()]);
  };

  // 生成/更新摘要
  const handleGenerateSummary = async () => {
    if (!currentSessionId) return;
    setGeneratingSummary(true);
    try {
      const data = await generateSessionSummary(currentSessionId);
      setSummary(data);
    } catch (error) {
      console.error('生成摘要失败:', error);
    } finally {
      setGeneratingSummary(false);
    }
  };

  // 删除记忆
  const handleDeleteMemory = async (id: number) => {
    try {
      await deleteUserMemory(id);
      setMemories(prev => prev.filter(m => m.id !== id));
      if (editingId === id) setEditingId(null);
    } catch (error) {
      console.error('删除记忆失败:', error);
    }
  };

  // 添加记忆
  const handleAddMemory = async () => {
    if (!newMemoryContent.trim()) return;
    setAddingMemory(true);
    try {
      const result = await addUserMemory(newMemoryContent, newMemoryCategory, 3);
      if (result.success && result.memory) {
        setMemories(prev => [...prev, result.memory!]);
      }
      setNewMemoryContent('');
      setShowAddForm(false);
    } catch (error) {
      console.error('添加记忆失败:', error);
    } finally {
      setAddingMemory(false);
    }
  };

  // 进入编辑模式
  const startEdit = (memory: UserMemoryData) => {
    setEditingId(memory.id);
    setEditContent(memory.content);
    setEditCategory(memory.category);
  };

  // 取消编辑
  const cancelEdit = () => {
    setEditingId(null);
    setEditContent('');
    setEditCategory('');
  };

  // 保存编辑
  const handleSaveEdit = async (id: number) => {
    if (!editContent.trim()) return;
    setSavingEdit(true);
    try {
      const result = await updateUserMemory(id, editContent, editCategory);
      if (result.success && result.memory) {
        setMemories(prev => prev.map(m => m.id === id ? result.memory! : m));
      }
      setEditingId(null);
    } catch (error) {
      console.error('更新记忆失败:', error);
    } finally {
      setSavingEdit(false);
    }
  };

  // 打开时加载数据
  useEffect(() => {
    if (open) {
      loadMemories();
      loadSummary();
    }
  }, [open, currentSessionId]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 遮罩层 */}
      <div className="absolute inset-0 bg-black/50 cyberpunk-ms-dialog-bg" onClick={onClose} />

      {/* 对话框主体 */}
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col overflow-hidden cyberpunk-ms-dialog-card">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center space-x-2">
            <Brain className="h-5 w-5 text-primary cyberpunk-ms-title-icon" />
            <h2 className="text-lg font-semibold text-foreground cyberpunk-ms-title">记忆与摘要</h2>
          </div>
          <div className="flex items-center space-x-2">
            <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={memoriesLoading || summaryLoading}>
              <RefreshCw className={`h-4 w-4 mr-1 ${memoriesLoading || summaryLoading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full">
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* 内容区 - Tabs */}
        <Tabs defaultValue="memories" className="flex-1 flex flex-col overflow-hidden">
          <div className="px-6 pt-3">
            <TabsList className="w-full">
              <TabsTrigger value="memories" className="flex-1">
                <Brain className="h-4 w-4 mr-1" />
                记忆库
              </TabsTrigger>
              <TabsTrigger value="summary" className="flex-1">
                <FileText className="h-4 w-4 mr-1" />
                对话摘要
              </TabsTrigger>
            </TabsList>
          </div>

          {/* 记忆库 Tab */}
          <TabsContent value="memories" className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground cyberpunk-ms-subtext">
                共 {memories.length} 条记忆
              </span>
              <Button variant="outline" size="sm" onClick={() => setShowAddForm(!showAddForm)}>
                <Plus className="h-4 w-4 mr-1" />
                添加
              </Button>
            </div>

            {/* 添加记忆表单 */}
            {showAddForm && (
              <div className="p-3 rounded-lg border border-border bg-muted/50 space-y-2 cyberpunk-ms-form">
                <textarea
                  value={newMemoryContent}
                  onChange={(e) => setNewMemoryContent(e.target.value)}
                  placeholder="输入记忆内容..."
                  className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background text-foreground resize-none focus:outline-none focus:ring-2 focus:ring-ring cyberpunk-ms-input"
                  rows={2}
                />
                <div className="flex items-center justify-between">
                  <select
                    value={newMemoryCategory}
                    onChange={(e) => setNewMemoryCategory(e.target.value)}
                    className="px-2 py-1 text-sm rounded-md border border-input bg-background text-foreground cyberpunk-ms-input"
                  >
                    {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                  <div className="flex items-center space-x-2">
                    <Button variant="ghost" size="sm" onClick={() => setShowAddForm(false)}>取消</Button>
                    <Button size="sm" onClick={handleAddMemory} disabled={addingMemory || !newMemoryContent.trim()}>
                      {addingMemory ? <Loader2 className="h-4 w-4 animate-spin" /> : '添加'}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* 记忆列表 */}
            {memoriesLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : memories.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm cyberpunk-ms-empty">
                暂无记忆数据
              </div>
            ) : (
              memories.map((memory) => (
                <div
                  key={memory.id}
                  className="p-3 rounded-lg border border-border bg-card hover:shadow-sm transition-shadow cyberpunk-ms-card"
                >
                  {editingId === memory.id ? (
                    /* 编辑模式 */
                    <div className="space-y-2">
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="w-full px-3 py-2 text-sm rounded-md border border-primary bg-background text-foreground resize-none focus:outline-none focus:ring-2 focus:ring-ring cyberpunk-ms-input"
                        rows={2}
                      />
                      <div className="flex items-center justify-between">
                        <select
                          value={editCategory}
                          onChange={(e) => setEditCategory(e.target.value)}
                          className="px-2 py-1 text-sm rounded-md border border-input bg-background text-foreground cyberpunk-ms-input"
                        >
                          {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                            <option key={key} value={key}>{label}</option>
                          ))}
                        </select>
                        <div className="flex items-center space-x-2">
                          <Button variant="ghost" size="sm" onClick={cancelEdit}>取消</Button>
                          <Button size="sm" onClick={() => handleSaveEdit(memory.id)} disabled={savingEdit || !editContent.trim()}>
                            {savingEdit ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
                            保存
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* 展示模式 */
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground break-words cyberpunk-ms-text">
                          {memory.content}
                        </p>
                        <div className="flex items-center space-x-2 mt-2">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium cyberpunk-ms-badge ${CATEGORY_COLORS[memory.category] || 'bg-muted text-muted-foreground'}`}>
                            {CATEGORY_LABELS[memory.category] || memory.category}
                          </span>
                          <span className="text-xs text-muted-foreground cyberpunk-ms-subtext">
                            重要度: {memory.importance}
                          </span>
                          <span className="text-xs text-muted-foreground cyberpunk-ms-subtext">
                            访问: {memory.accessCount}次
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center space-x-1 shrink-0 ml-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-primary"
                          onClick={() => startEdit(memory)}
                          title="编辑"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDeleteMemory(memory.id)}
                          title="删除"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </TabsContent>

          {/* 对话摘要 Tab */}
          <TabsContent value="summary" className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground cyberpunk-ms-subtext">
                当前会话摘要
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleGenerateSummary}
                disabled={generatingSummary}
              >
                {generatingSummary ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-1" />
                )}
                {summary?.summaryContent ? '重新生成' : '生成摘要'}
              </Button>
            </div>

            {summaryLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : summary?.summaryContent ? (
              <div className="p-4 rounded-lg border border-border bg-card cyberpunk-ms-card">
                <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed cyberpunk-ms-text">
                  {summary.summaryContent}
                </p>
                <div className="flex items-center space-x-3 mt-3 pt-3 border-t border-border">
                  <span className="text-xs text-muted-foreground cyberpunk-ms-subtext">
                    覆盖消息数: {summary.coveredMessageCount}
                  </span>
                  {summary.updatedAt && (
                    <span className="text-xs text-muted-foreground cyberpunk-ms-subtext">
                      更新于: {new Date(summary.updatedAt).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground text-sm cyberpunk-ms-empty">
                暂无摘要，点击上方按钮生成
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};

export default MemorySummaryDialog;
