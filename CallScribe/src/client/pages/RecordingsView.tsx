import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PhoneIncoming, PhoneOutgoing, Clock, Mail, MessageSquare, AlertCircle, Loader2, Pencil, Check, X, Calendar, Trash2 } from 'lucide-react';
import { api } from '../api/client';

interface Recording {
  id: string;
  phone_number: string;
  contact_name: string | null;
  direction: string;
  started_at: string;
  duration_seconds: number | null;
  transcript_status: string;
  email_sent: boolean;
  has_notes: boolean;
  created_at: string;
}

export default function RecordingsView({ searchQuery, onContactSaved }: { searchQuery: string; onContactSaved?: () => void }) {
  const navigate = useNavigate();
  const { phoneNumber } = useParams<{ phoneNumber: string }>();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const [contactName, setContactName] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);

  const decodedNumber = phoneNumber ? decodeURIComponent(phoneNumber) : undefined;

  useEffect(() => {
    setLoading(true);
    const params: Record<string, string> = {};
    if (decodedNumber) params.phone_number = decodedNumber;
    if (searchQuery) params.search = searchQuery;
    if (fromDate) params.from = fromDate;
    if (toDate) params.to = toDate;

    api.getRecordings(params)
      .then(data => {
        setRecordings(data.recordings);
        setTotal(data.total);
        if (decodedNumber && data.recordings.length) {
          setContactName(data.recordings[0].contact_name);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [decodedNumber, searchQuery, fromDate, toDate]);

  const startEditName = () => {
    setNameDraft(contactName || '');
    setEditingName(true);
  };

  const saveName = async () => {
    if (!decodedNumber) return;
    setSavingName(true);
    try {
      const res = await api.setContactName(decodedNumber, nameDraft);
      setContactName(res.name);
      setRecordings(prev => prev.map(r => ({ ...r, contact_name: res.name })));
      setEditingName(false);
      onContactSaved?.();
    } catch {}
    setSavingName(false);
  };

  const handleDeleteRecording = async (e: React.MouseEvent, rec: Recording) => {
    e.stopPropagation();
    if (!window.confirm(`Delete this recording from ${rec.contact_name || rec.phone_number}? The audio and transcript are removed permanently.`)) return;
    try {
      await api.deleteRecording(rec.id);
      setRecordings(prev => prev.filter(r => r.id !== rec.id));
      setTotal(t => Math.max(0, t - 1));
      onContactSaved?.();
    } catch {}
  };

  const handleDeleteContact = async () => {
    if (!decodedNumber) return;
    const label = contactName || decodedNumber;
    if (!window.confirm(`Delete "${label}" and ALL ${total} recording${total !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    try {
      await api.deleteContact(decodedNumber);
      onContactSaved?.();
      navigate('/');
    } catch {}
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return '--';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const startOfDay = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };

  const formatDateLabel = (iso: string) => {
    const d = new Date(iso);
    const diffDays = Math.round((startOfDay(new Date()).getTime() - startOfDay(d).getTime()) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };

  const statusChip = (status: string) => {
    const styles: Record<string, { bg: string; color: string; label: string }> = {
      pending: { bg: 'var(--gray-200)', color: 'var(--gray-600)', label: 'Pending' },
      processing: { bg: '#dbeafe', color: '#1d4ed8', label: 'Processing' },
      completed: { bg: '#dcfce7', color: '#16a34a', label: 'Completed' },
      failed: { bg: '#fee2e2', color: '#dc2626', label: 'Failed' },
    };
    const s = styles[status] || styles.pending;
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        fontSize: '0.7rem', fontWeight: 600, padding: '2px 8px',
        borderRadius: '10px', background: s.bg, color: s.color,
      }}>
        {status === 'processing' && <Loader2 size={12} className="spin" />}
        {status === 'failed' && <AlertCircle size={12} />}
        {s.label}
      </span>
    );
  };

  const title = decodedNumber ? (contactName || decodedNumber) : 'All Recordings';
  const dateFiltered = !!(fromDate || toDate);

  return (
    <div className="recordings-view">
      <div className="view-header">
        {decodedNumber && editingName ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <input
              className="contact-name-input"
              autoFocus
              value={nameDraft}
              placeholder="Contact name"
              onChange={e => setNameDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }}
            />
            <button className="icon-btn" onClick={saveName} disabled={savingName} title="Save name">
              {savingName ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
            </button>
            <button className="icon-btn" onClick={() => setEditingName(false)} title="Cancel"><X size={16} /></button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <h2 className="view-title">{title}</h2>
            {decodedNumber && (
              <button className="icon-btn" onClick={startEditName} title="Assign name to this contact">
                <Pencil size={14} />
              </button>
            )}
          </div>
        )}
        {decodedNumber && contactName && !editingName && (
          <span className="view-count">{decodedNumber}</span>
        )}
        <span className="view-count">{total} recording{total !== 1 ? 's' : ''}</span>
        {decodedNumber && !editingName && (
          <button className="btn btn-sm btn-danger" onClick={handleDeleteContact} style={{ marginLeft: 'auto' }}>
            <Trash2 size={14} /> Delete contact
          </button>
        )}
      </div>

      <div className="recordings-filterbar">
        <Calendar size={16} style={{ color: 'var(--text-muted)' }} />
        <label className="filter-field">
          From <input type="date" value={fromDate} max={toDate || undefined} onChange={e => setFromDate(e.target.value)} />
        </label>
        <label className="filter-field">
          To <input type="date" value={toDate} min={fromDate || undefined} onChange={e => setToDate(e.target.value)} />
        </label>
        {dateFiltered && (
          <button className="btn btn-sm" onClick={() => { setFromDate(''); setToDate(''); }}>Clear</button>
        )}
      </div>

      {loading ? (
        <div className="loading">Loading recordings...</div>
      ) : recordings.length === 0 ? (
        <div className="empty-state">
          <PhoneIncoming size={48} style={{ opacity: 0.3, marginBottom: '1rem' }} />
          <h3>No recordings</h3>
          <p style={{ marginTop: '0.5rem' }}>
            {dateFiltered
              ? 'No recordings match the selected dates'
              : decodedNumber
                ? `No recordings found for ${decodedNumber}`
                : searchQuery
                  ? 'No recordings match your search'
                  : 'Recordings from the CallScribe Android app will appear here'}
          </p>
        </div>
      ) : (
        <div className="recordings-list">
          {recordings.map(rec => (
            <div
              key={rec.id}
              className="recording-card"
              onClick={() => navigate(`/recording/${rec.id}`)}
            >
              <div className="recording-card-icon">
                {rec.direction === 'incoming'
                  ? <PhoneIncoming size={20} />
                  : <PhoneOutgoing size={20} />}
              </div>

              <div className="recording-card-info">
                <div className="recording-card-primary">
                  <span className="recording-phone">{rec.contact_name || rec.phone_number}</span>
                  {rec.contact_name && <span className="recording-subnumber">{rec.phone_number}</span>}
                  <span className="recording-direction">{rec.direction}</span>
                </div>
                <div className="recording-card-secondary">
                  <span>{formatDateLabel(rec.started_at)} at {formatTime(rec.started_at)}</span>
                  <span className="recording-duration">
                    <Clock size={12} /> {formatDuration(rec.duration_seconds)}
                  </span>
                </div>
              </div>

              <div className="recording-card-status">
                {statusChip(rec.transcript_status)}
                <div className="recording-card-icons">
                  {rec.email_sent && <Mail size={14} style={{ color: 'var(--gray-400)' }} title="Email sent" />}
                  {rec.has_notes && <MessageSquare size={14} style={{ color: 'var(--primary)' }} title="Has notes" />}
                </div>
              </div>

              <button
                className="icon-btn recording-delete"
                onClick={e => handleDeleteRecording(e, rec)}
                title="Delete recording"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
