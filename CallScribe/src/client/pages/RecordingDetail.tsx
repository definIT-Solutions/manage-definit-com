import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, PhoneIncoming, PhoneOutgoing, Clock, Mail, MailX, Save, FileText, AlertCircle, Loader2, Check, Play, Trash2 } from 'lucide-react';
import { api } from '../api/client';

interface RecordingData {
  id: string;
  phone_number: string;
  direction: string;
  started_at: string;
  duration_seconds: number | null;
  transcript_status: string;
  transcript: string | null;
  transcript_error: string | null;
  email_sent: boolean;
  email_sent_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export default function RecordingDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [recording, setRecording] = useState<RecordingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api.getRecording(id)
      .then(data => {
        setRecording(data);
        setNotes(data.notes || '');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  // Auto-save notes after 2 seconds of inactivity
  useEffect(() => {
    if (!notesDirty || !id) return;
    const timer = setTimeout(async () => {
      setSaving(true);
      try {
        await api.updateNotes(id, notes);
        setNotesDirty(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch {}
      setSaving(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [notes, notesDirty, id]);

  const handleDelete = async () => {
    if (!id || !recording) return;
    if (!window.confirm(`Delete this recording from ${recording.phone_number}? The audio and transcript are removed permanently.`)) return;
    try {
      await api.deleteRecording(id);
      navigate(-1);
    } catch {}
  };

  const handleSaveNotes = async () => {
    if (!id) return;
    setSaving(true);
    try {
      await api.updateNotes(id, notes);
      setNotesDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
    setSaving(false);
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return 'Unknown duration';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  };

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  };

  if (loading) return <div className="loading">Loading recording...</div>;
  if (!recording) return <div className="empty-state"><h3>Recording not found</h3></div>;

  return (
    <div className="recording-detail">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button className="back-btn" onClick={() => navigate(-1)}>
          <ArrowLeft size={18} /> Back
        </button>
        <button className="btn btn-sm btn-danger" onClick={handleDelete}>
          <Trash2 size={14} /> Delete
        </button>
      </div>

      {/* Header */}
      <div className="detail-header">
        <div className="detail-header-icon">
          {recording.direction === 'incoming'
            ? <PhoneIncoming size={28} />
            : <PhoneOutgoing size={28} />}
        </div>
        <div className="detail-header-info">
          <h2>{recording.phone_number}</h2>
          <div className="detail-meta">
            <span className="detail-direction">{recording.direction}</span>
            <span><Clock size={14} /> {formatDuration(recording.duration_seconds)}</span>
            <span>{formatDate(recording.started_at)}</span>
          </div>
          <div className="detail-badges">
            <span className={`status-badge status-${recording.transcript_status}`}>
              {recording.transcript_status === 'processing' && <Loader2 size={12} className="spin" />}
              {recording.transcript_status === 'failed' && <AlertCircle size={12} />}
              {recording.transcript_status === 'completed' && <Check size={12} />}
              {recording.transcript_status}
            </span>
            {recording.email_sent
              ? <span className="status-badge status-email-sent"><Mail size={12} /> Emailed {recording.email_sent_at ? formatDate(recording.email_sent_at) : ''}</span>
              : <span className="status-badge status-email-pending"><MailX size={12} /> Not emailed</span>}
          </div>
        </div>
      </div>

      {/* Audio Player */}
      <div className="detail-player">
        <div className="detail-section-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Play size={18} />
            <h3>Recording</h3>
          </span>
        </div>
        <div className="player-container">
          <audio
            controls
            preload="metadata"
            style={{ width: '100%' }}
            src={api.getAudioUrl(recording.id)}
          >
            Your browser does not support the audio element.
          </audio>
        </div>
      </div>

      {/* Error */}
      {recording.transcript_error && (
        <div className="detail-error">
          <AlertCircle size={16} />
          <span>Transcription error: {recording.transcript_error}</span>
        </div>
      )}

      {/* Two-column: Transcript + Notes */}
      <div className="detail-columns">
        <div className="detail-transcript">
          <div className="detail-section-header">
            <FileText size={18} />
            <h3>Transcript</h3>
          </div>
          {recording.transcript ? (
            <div
              className="transcript-content"
              dangerouslySetInnerHTML={{ __html: formatMarkdown(recording.transcript) }}
            />
          ) : (
            <div className="transcript-empty">
              {recording.transcript_status === 'pending' && 'Waiting for transcription...'}
              {recording.transcript_status === 'processing' && 'Transcription in progress...'}
              {recording.transcript_status === 'failed' && 'Transcription failed.'}
            </div>
          )}
        </div>

        <div className="detail-notes">
          <div className="detail-section-header">
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <FileText size={18} />
              <h3>Notes</h3>
            </span>
            <div className="notes-status">
              {saving && <span className="save-indicator"><Loader2 size={14} className="spin" /> Saving...</span>}
              {saved && <span className="save-indicator saved"><Check size={14} /> Saved</span>}
              {notesDirty && !saving && (
                <button className="btn btn-primary btn-sm" onClick={handleSaveNotes}>
                  <Save size={14} /> Save
                </button>
              )}
            </div>
          </div>
          <textarea
            className="notes-editor"
            placeholder="Add notes about this call..."
            value={notes}
            onChange={e => { setNotes(e.target.value); setNotesDirty(true); }}
            rows={12}
          />
        </div>
      </div>
    </div>
  );
}

// Simple markdown-to-HTML for transcript display
function formatMarkdown(md: string): string {
  return md
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^\- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hul])(.+)$/gm, '<p>$1</p>')
    .replace(/<p><\/p>/g, '');
}
