import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import './App.css';

const socket = io('http://localhost:5000');

/* ── helpers ── */
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateSeparator(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

function groupByDate(messages) {
  const groups = [];
  let lastDate = null;
  messages.forEach((msg) => {
    const dateStr = msg.timestamp
      ? new Date(msg.timestamp).toDateString()
      : 'Unknown';
    if (dateStr !== lastDate) {
      groups.push({ type: 'separator', label: formatDateSeparator(msg.timestamp) });
      lastDate = dateStr;
    }
    groups.push({ type: 'message', data: msg });
  });
  return groups;
}

/* ── Send icon SVG ── */
const SendIcon = () => (
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
  </svg>
);

/* ═══════════════════════════════════════════════════════════════ */
function App() {
  const [isLoggedIn, setIsLoggedIn]   = useState(false);
  const [username, setUsername]       = useState('');
  const [password, setPassword]       = useState('');
  const [token, setToken]             = useState('');
  const [messages, setMessages]       = useState([]);
  const [input, setInput]             = useState('');
  const [isRegister, setIsRegister]   = useState(false);
  const [error, setError]             = useState('');
  const bottomRef                     = useRef(null);
  const seenMessagesRef               = useRef(new Set());
  const pendingMessageIdsRef          = useRef({});

  /* scroll to bottom on new messages */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* restore session */
  useEffect(() => {
    const storedToken    = localStorage.getItem('token');
    const storedUsername = localStorage.getItem('username');
    if (storedToken && storedUsername) {
      setToken(storedToken);
      setUsername(storedUsername);
      setIsLoggedIn(true);
    }
  }, []);

  /* join + fetch on login */
  useEffect(() => {
    if (isLoggedIn) {
      if (!socket.connected) socket.connect();
      socket.emit('join', username);
      fetchMessages();
    }
  }, [isLoggedIn, username]);

  /* socket listeners */
  useEffect(() => {
    socket.on('receive message', (message) => {
      setMessages((prev) => [...prev, { ...message, status: 'delivered' }]);
    });

    socket.on('previous messages', (msgs) => {
      setMessages(msgs);
    });

    socket.on('message status', ({ messageId, status, seenBy = [] }) => {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId ? { ...msg, status, seenBy } : msg
        )
      );
    });

    return () => {
      socket.off('receive message');
      socket.off('previous messages');
      socket.off('message status');
    };
  }, []);

  useEffect(() => {
    if (!isLoggedIn) return;

    messages.forEach((msg) => {
      if (msg.id && msg.username !== username && !seenMessagesRef.current.has(msg.id)) {
        socket.emit('message seen', { messageId: msg.id });
        seenMessagesRef.current.add(msg.id);
      }
    });
  }, [messages, isLoggedIn, username]);

  const fetchMessages = async () => {
    try {
      const res = await axios.get('http://localhost:5000/messages', {
        headers: { Authorization: `Bearer ${token}` },
      });
      setMessages(res.data);
    } catch {
      setError('Unable to fetch messages.');
    }
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    const url = isRegister ? '/register' : '/login';
    try {
      const res = await axios.post(`http://localhost:5000${url}`, { username, password });
      if (!isRegister) {
        setToken(res.data.token);
        localStorage.setItem('token', res.data.token);
        localStorage.setItem('username', username);
        setIsLoggedIn(true);
        setError('');
        if (!socket.connected) socket.connect();
      } else {
        setError('Registered successfully. Please login.');
        setIsRegister(false);
      }
    } catch (err) {
      setError(err.response?.data || 'Authentication failed.');
    }
  };

  const handleLogout = () => {
    if (socket.connected) socket.disconnect();
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    setIsLoggedIn(false);
    setToken('');
    setUsername('');
    setMessages([]);
    setInput('');
    setError('');
    setIsRegister(false);
    seenMessagesRef.current.clear();
    pendingMessageIdsRef.current = {};
  };

  const sendMessage = (e) => {
    e.preventDefault();
    if (!input.trim()) return;

    const tempId = `temp-${Date.now()}`;
    const outgoing = {
      id: tempId,
      username,
      text: input,
      timestamp: new Date().toISOString(),
      status: 'sent',
    };

    setMessages((prev) => [...prev, outgoing]);
    pendingMessageIdsRef.current[tempId] = true;

    socket.emit('send message', { text: input }, ({ message, delivered, error }) => {
      if (error) {
        setError(error);
        return;
      }

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === tempId
            ? { ...message, status: delivered ? 'delivered' : 'sent' }
            : msg
        )
      );
    });

    setInput('');
  };

  /* ── Auth Screen ── */
  if (!isLoggedIn) {
    return (
      <div className="app-shell">
        <div className="auth-card">
          <div className="auth-header">
            <div className="logo">💬</div>
            <div>
              <h1>{isRegister ? 'Create Account' : 'Welcome Back'}</h1>
              <p>{isRegister ? 'Fill the form to join the chat.' : 'Login to join the group conversation.'}</p>
            </div>
          </div>

          <form className="auth-form" onSubmit={handleAuth}>
            <label>
              Username
              <input
                type="text"
                placeholder="Your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                placeholder="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button className="primary-button" type="submit">
              {isRegister ? 'Register' : 'Login'}
            </button>
          </form>

          {error && <div className="notice">{error}</div>}

          <button
            className="secondary-button"
            onClick={() => { setIsRegister(!isRegister); setError(''); }}
          >
            {isRegister ? 'Already have an account? Login' : "Don't have an account? Register"}
          </button>
        </div>
      </div>
    );
  }

  /* ── Chat Screen ── */
  const grouped = groupByDate(messages);

  return (
    <div className="app-shell chat-shell">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="brand">
          <span>💬</span>
          <div>
            <h2>WhatsApp Chat</h2>
            <p>Group chat for all users</p>
          </div>
        </div>

        <div className="profile-card">
          <p className="profile-label">Logged in as</p>
          <strong>{username}</strong>
        </div>

        <div className="sidebar-note">
          <p>Open this page in multiple tabs to test group chat. New messages appear for everyone in real time.</p>
        </div>
      </aside>

      {/* ── Chat Panel ── */}
      <div className="chat-panel">
        {/* header */}
        <div className="chat-header">
          <div className="chat-header-info">
            <div className="chat-avatar">👥</div>
            <div>
              <h2>Group Chat</h2>
              <p>Connected as <strong>{username}</strong></p>
            </div>
          </div>
          <button className="logout-button" onClick={handleLogout}>Logout</button>
        </div>

        {/* messages */}
        <div className="messages">
          {messages.length === 0 && (
            <p className="empty-state">No messages yet. Start the conversation! 👋</p>
          )}

          {grouped.map((item, idx) => {
            if (item.type === 'separator') {
              return (
                <div key={`sep-${idx}`} className="date-separator">
                  <span>{item.label}</span>
                </div>
              );
            }
            const msg = item.data;
            const isMe = msg.username === username;
            return (
              <div key={idx} className={`message ${isMe ? 'mine' : ''}`}>
                {!isMe && <span className="sender">{msg.username}</span>}
                <div className="bubble">
                  <span className="bubble-text">{msg.text}</span>
                  <div className="bubble-meta">
                    <span>{formatTime(msg.timestamp)}</span>
                    {isMe && (
                      <span className={`tick ${msg.status === 'seen' ? 'seen' : ''}`}>
                        {msg.status === 'sent' ? '✓' : '✓✓'}
                      </span>
                    )}
                  </div>
                  {isMe && msg.seenBy?.length > 0 && (
                    <div className="bubble-seen">
                      Seen by {msg.seenBy.join(', ')}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          <div ref={bottomRef} />
        </div>

        {/* composer */}
        <form className="composer" onSubmit={sendMessage}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message"
            autoComplete="off"
          />
          <button className="send-button" type="submit" aria-label="Send">
            <SendIcon />
          </button>
        </form>
      </div>
    </div>
  );
}

export default App;