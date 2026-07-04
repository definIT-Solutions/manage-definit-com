import React, { useState } from 'react';
import { Pin, Archive, Trash2, Plus, X, Tag, Palette, Globe, Lock } from 'lucide-react';
import { api } from '../api/client';
import { NOTE_COLORS, relativeDate, type Note } from './NoteCard';

interface Label {
  id: string;
  name: string;
  _count: { noteLabels: number };
}

interface NoteEditorProps {
  note: Note;
  labels: Label[];
  isOwner: boolean;
  onClose: () => void;
  onUpdate: (note: Note) => void;
  onDelete: () => void;
}

export default function NoteEditor({ note, labels, isOwner, onClose, onUpdate, onDelete }: NoteEditorProps) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [color, setColor] = useState(note.color);
  const [pinned, setPinned] = useState(note.pinned);
  const [visibility, setVisibility] = useState(note.visibility);
  const [checklistItems, setChecklistItems] = useState(note.checklistItems);
  const [noteLabels, setNoteLabels] = useState(note.noteLabels);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [newItemText, setNewItemText] = useState('');
  const [saving, setSaving] = useState(false);

  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  const bgColor = NOTE_COLORS[color]?.[theme as 'light' | 'dark'] || NOTE_COLORS.default[theme as 'light' | 'dark'];

  const saveNote = async () => {
    if (!isOwner) return;
    setSaving(true);
    try {
      const { note: updated } = await api.updateNote(note.id, { title, content, color, pinned, visibility });
      onUpdate(updated);
    } catch (e) {}
    setSaving(false);
  };

  const handleClose = async () => {
    if (isOwner && (title !== note.title || content !== note.content || color !== note.color || pinned !== note.pinned || visibility !== note.visibility)) {
      await saveNote();
    }
    onClose();
  };

  const handleToggleCheck = async (itemId: string, checked: boolean) => {
    if (!isOwner) return;
    await api.updateChecklistItem(note.id, itemId, { checked });
    setChecklistItems(prev => prev.map(i => i.id === itemId ? { ...i, checked } : i));
  };

  const handleAddItem = async () => {
    if (!newItemText.trim() || !isOwner) return;
    const { item } = await api.addChecklistItem(note.id, { text: newItemText });
    setChecklistItems(prev => [...prev, item]);
    setNewItemText('');
  };

  const handleDeleteItem = async (itemId: string) => {
    if (!isOwner) return;
    await api.deleteChecklistItem(note.id, itemId);
    setChecklistItems(prev => prev.filter(i => i.id !== itemId));
  };

  const handleToggleLabel = async (labelId: string) => {
    if (!isOwner) return;
    const hasLabel = noteLabels.some(nl => nl.label.id === labelId);
    if (hasLabel) {
      await api.removeNoteLabel(note.id, labelId);
      setNoteLabels(prev => prev.filter(nl => nl.label.id !== labelId));
    } else {
      const { noteLabel } = await api.addNoteLabel(note.id, labelId);
      setNoteLabels(prev => [...prev, noteLabel]);
    }
  };

  const handleArchive = async () => {
    if (!isOwner) return;
    if (note.archived) {
      await api.unarchiveNote(note.id);
    } else {
      await api.archiveNote(note.id);
    }
    onDelete();
  };

  const handleTrash = async () => {
    if (!isOwner) return;
    await api.trashNote(note.id);
    onDelete();
  };

  const toggleVisibility = async () => {
    if (!isOwner) return;
    const next = visibility === 'public' ? 'private' : 'public';
    setVisibility(next);
    await api.updateNote(note.id, { visibility: next });
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal note-editor-modal" style={{ backgroundColor: bgColor }} onClick={e => e.stopPropagation()}>
        <div className="note-editor-header">
          <input
            type="text"
            className="note-editor-title"
            placeholder="Title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            onBlur={saveNote}
            readOnly={!isOwner}
          />
          {isOwner && (
            <button className={`icon-btn ${pinned ? 'active' : ''}`} onClick={async () => { setPinned(!pinned); await api.updateNote(note.id, { pinned: !pinned }); }} title={pinned ? 'Unpin' : 'Pin'}>
              <Pin size={18} />
            </button>
          )}
        </div>

        <div className="note-editor-date" style={{ fontSize: 13, opacity: 0.6, padding: '2px 0 8px' }}>{relativeDate(note.createdAt)}</div>

        <textarea
          className="note-editor-content"
          placeholder="Take a note..."
          value={content}
          onChange={e => setContent(e.target.value)}
          onBlur={saveNote}
          rows={4}
          readOnly={!isOwner}
        />

        {checklistItems.length > 0 && (
          <div className="note-editor-checklist">
            {checklistItems.filter(i => !i.checked).map(item => (
              <div key={item.id} className="editor-check-item">
                <input type="checkbox" checked={false} onChange={() => handleToggleCheck(item.id, true)} disabled={!isOwner} />
                <span>{item.text}</span>
                {isOwner && <button className="icon-btn-sm" onClick={() => handleDeleteItem(item.id)}><X size={12} /></button>}
              </div>
            ))}
            {checklistItems.some(i => i.checked) && (
              <>
                <div className="checked-divider">{checklistItems.filter(i => i.checked).length} checked</div>
                {checklistItems.filter(i => i.checked).map(item => (
                  <div key={item.id} className="editor-check-item checked">
                    <input type="checkbox" checked={true} onChange={() => handleToggleCheck(item.id, false)} disabled={!isOwner} />
                    <span>{item.text}</span>
                    {isOwner && <button className="icon-btn-sm" onClick={() => handleDeleteItem(item.id)}><X size={12} /></button>}
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {isOwner && (
          <div className="editor-add-item">
            <Plus size={14} />
            <input
              type="text"
              placeholder="Add item"
              value={newItemText}
              onChange={e => setNewItemText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { handleAddItem(); } }}
            />
          </div>
        )}

        {noteLabels.length > 0 && (
          <div className="note-editor-labels">
            {noteLabels.map(nl => (
              <span key={nl.id} className="note-label-chip">
                {nl.label.name}
                {isOwner && <button onClick={() => handleToggleLabel(nl.label.id)}><X size={10} /></button>}
              </span>
            ))}
          </div>
        )}

        {!isOwner && (
          <div className="note-editor-readonly">
            By {note.user.displayName}
          </div>
        )}

        <div className="note-editor-toolbar">
          <div className="toolbar-left">
            {isOwner && (
              <div className="toolbar-group">
                <button className="icon-btn-sm" onClick={() => setShowColorPicker(!showColorPicker)} title="Color"><Palette size={16} /></button>
                <button className="icon-btn-sm" onClick={() => setShowLabelPicker(!showLabelPicker)} title="Labels"><Tag size={16} /></button>
                <button className={`icon-btn-sm ${visibility === 'public' ? 'active' : ''}`} onClick={toggleVisibility} title={visibility === 'public' ? 'Make private' : 'Make public'}>
                  {visibility === 'public' ? <Globe size={16} /> : <Lock size={16} />}
                </button>
                <button className="icon-btn-sm" onClick={handleArchive} title={note.archived ? 'Unarchive' : 'Archive'}>
                  <Archive size={16} />
                </button>
                <button className="icon-btn-sm" onClick={handleTrash} title="Delete">
                  <Trash2 size={16} />
                </button>
              </div>
            )}
          </div>
          <button className="btn btn-sm" onClick={handleClose}>Close</button>
        </div>

        {showColorPicker && (
          <div className="color-picker">
            {Object.entries(NOTE_COLORS).map(([id, colors]) => (
              <button
                key={id}
                className={`color-dot ${color === id ? 'selected' : ''}`}
                style={{ backgroundColor: colors[theme as 'light' | 'dark'] }}
                onClick={async () => { setColor(id); setShowColorPicker(false); await api.updateNote(note.id, { color: id }); }}
                title={id}
              />
            ))}
          </div>
        )}

        {showLabelPicker && (
          <div className="label-picker">
            {labels.map(label => (
              <label key={label.id} className="label-picker-item">
                <input
                  type="checkbox"
                  checked={noteLabels.some(nl => nl.label.id === label.id)}
                  onChange={() => handleToggleLabel(label.id)}
                />
                <span>{label.name}</span>
              </label>
            ))}
            {labels.length === 0 && <div className="label-picker-empty">No labels yet</div>}
          </div>
        )}
      </div>
    </div>
  );
}
