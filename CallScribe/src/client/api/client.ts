const API_BASE = '/callscribe/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { ...headers, ...options?.headers },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

export const api = {
  getMe: () => request<any>('/auth/me'),

  getRecordings: (params?: Record<string, string>) => {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<any>(`/recordings${query}`);
  },

  getRecording: (id: string) => request<any>(`/recordings/${id}`),

  updateNotes: (id: string, notes: string) =>
    request<any>(`/recordings/${id}/notes`, {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    }),

  getPhoneNumbers: () => request<any>('/recordings-meta/phone-numbers'),

  getContacts: () => request<any>('/contacts'),

  setContactName: (phoneNumber: string, name: string) =>
    request<any>(`/contacts/${encodeURIComponent(phoneNumber)}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),

  deleteRecording: (id: string) =>
    request<any>(`/recordings/${id}`, { method: 'DELETE' }),

  deleteContact: (phoneNumber: string) =>
    request<any>(`/contacts/${encodeURIComponent(phoneNumber)}`, { method: 'DELETE' }),

  getAudioUrl: (id: string) => `${API_BASE}/recordings/${id}/audio`,

  getHealth: () => request<any>('/health'),
};
