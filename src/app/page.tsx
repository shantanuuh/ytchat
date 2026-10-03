'use client';

import { useState, useRef, useEffect } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export default function Page() {
  const [activeTab, setActiveTab] = useState<'chat' | 'help' | 'about'>('chat');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [videoUrl, setVideoUrl] = useState('');
  const [videoId, setVideoId] = useState('');
  
  // Configuration & BYOK States
  const [userApiKey, setUserApiKey] = useState('');
  const [savedApiKey, setSavedApiKey] = useState('');
  const [keyValidationStatus, setKeyValidationStatus] = useState<'idle' | 'validating' | 'valid' | 'invalid'>('idle');
  const [validationMessage, setValidationMessage] = useState('');
  
  const [loading, setLoading] = useState(false);
  const [indexingStatus, setIndexingStatus] = useState('');
  
  // Chat states
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  
  // Modal state for "Check important information" info link
  const [showInfoModal, setShowInfoModal] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);

  // Add these with your existing useState hooks
  const [selectedProvider, setSelectedProvider] = useState('auto');
  const [showApiKey, setShowApiKey] = useState(false);  
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, chatLoading]);

  // Instant Key Validation
  const handleKeyChange = async (val: string) => {
    setUserApiKey(val);
    if (!val.trim()) {
      setKeyValidationStatus('idle');
      setValidationMessage('');
      return;
    }

    setKeyValidationStatus('validating');
    setValidationMessage('Checking key validity...');

    try {
      const res = await fetch('/api/verify-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: val }),
      });

      const data = await res.json();

      if (res.ok && (data.valid || data.success)) {
        setKeyValidationStatus('valid');
        setValidationMessage('API Key is valid and ready.');
      } else {
        setKeyValidationStatus('invalid');
        setValidationMessage(data.error || 'Invalid API key credentials.');
      }
    } catch {
      setKeyValidationStatus('invalid');
      setValidationMessage('Unable to verify key. Network or endpoint error.');
    }
  };

  const handleSaveApiKey = () => {
    if (keyValidationStatus === 'valid') {
      setSavedApiKey(userApiKey);
    }
  };

  // 1. Handle Video Indexing
  const handleIndexVideo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!videoUrl.trim() || loading) return;

    setLoading(true);
    setIndexingStatus('Fetching transcript & indexing chunks...');

    try {
      const res = await fetch('/api/transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl, apiKey: savedApiKey || userApiKey }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to index video');
      }

      setVideoId(data.videoId);
      setIndexingStatus('Video successfully indexed.');
      setMessages([]); // Starts with a clean message array
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      setIndexingStatus(`Error: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  };

  // Typewriter helper function to simulate streaming/typing text
  const simulateTypewriterEffect = (fullText: string) => {
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);
    let currentIndex = 0;
    
    const interval = setInterval(() => {
      if (currentIndex <= fullText.length) {
        const currentSlice = fullText.slice(0, currentIndex);
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: currentSlice };
          return updated;
        });
        currentIndex += Math.max(1, Math.floor(fullText.length / 40));
      } else {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: fullText };
          return updated;
        });
        clearInterval(interval);
        setChatLoading(false);
      }
    }, 20);
  };

  // 2. Handle Sending Chat Messages
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMessage.trim() || !videoId || chatLoading) return;

    const userQuery = inputMessage;
    setInputMessage('');
    setMessages((prev) => [...prev, { role: 'user', content: userQuery }]);
    setChatLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userQuery,
          videoId,
          apiKey: savedApiKey || userApiKey,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to get response');
      }

      simulateTypewriterEffect(data.reply);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${errorMessage}` }]);
      setChatLoading(false);
    }
  };

  return (
    <div className={`min-h-screen flex flex-col font-sans transition-colors duration-200 selection:bg-neutral-500 selection:text-white ${
      theme === 'dark' ? 'bg-[#0A0A0A] text-white' : 'bg-[#FAFAFA] text-neutral-900'
    }`}>
      
      {/* Top Navigation Bar */}
      <header className={`border-b backdrop-blur-md sticky top-0 z-50 px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between max-w-5xl mx-auto w-full transition-colors ${
        theme === 'dark' ? 'border-neutral-900 bg-[#0A0A0A]/80' : 'border-neutral-300 bg-white/90'
      }`}>
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Main Logo Image from the public folder */}
          <img 
            src="/logo.svg" 
            alt="YouTubeChat Logo" 
            className="w-8 h-8 object-contain" 
          />
          <span className="font-semibold tracking-tight text-base sm:text-lg">YouTubeChat</span>
        </div>

        <div className="flex items-center gap-2">
          {/* Nav Icons / Tabs */}
          <nav className={`flex items-center gap-1 p-1 rounded-full border text-sm transition-colors ${
            theme === 'dark' ? 'bg-neutral-900/60 border-neutral-800/60' : 'bg-neutral-100 border-neutral-300 shadow-sm'
          }`}>
            <button
              onClick={() => setActiveTab('chat')}
              title="Chat"
              aria-label="Chat"
              className={`p-2 sm:px-4 sm:py-1.5 rounded-full transition-all duration-200 flex items-center gap-1.5 ${
                activeTab === 'chat' 
                  ? (theme === 'dark' ? 'bg-white text-neutral-950 font-medium shadow-sm' : 'bg-neutral-900 text-white font-medium shadow-sm')
                  : (theme === 'dark' ? 'text-neutral-400 hover:text-white' : 'text-neutral-700 hover:text-neutral-950')
              }`}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
              <span className="hidden sm:inline">Chat</span>
            </button>

            <button
              onClick={() => setActiveTab('help')}
              title="Help & BYOK"
              aria-label="Help & BYOK"
              className={`p-2 sm:px-4 sm:py-1.5 rounded-full transition-all duration-200 flex items-center gap-1.5 ${
                activeTab === 'help' 
                  ? (theme === 'dark' ? 'bg-white text-neutral-950 font-medium shadow-sm' : 'bg-neutral-900 text-white font-medium shadow-sm')
                  : (theme === 'dark' ? 'text-neutral-400 hover:text-white' : 'text-neutral-700 hover:text-neutral-950')
              }`}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
              <span className="hidden sm:inline">Help & BYOK</span>
            </button>

            <button
              onClick={() => setActiveTab('about')}
              title="About"
              aria-label="About"
              className={`p-2 sm:px-4 sm:py-1.5 rounded-full transition-all duration-200 flex items-center gap-1.5 ${
                activeTab === 'about' 
                  ? (theme === 'dark' ? 'bg-white text-neutral-950 font-medium shadow-sm' : 'bg-neutral-900 text-white font-medium shadow-sm')
                  : (theme === 'dark' ? 'text-neutral-400 hover:text-white' : 'text-neutral-700 hover:text-neutral-950')
              }`}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
              <span className="hidden sm:inline">About</span>
            </button>
          </nav>

          {/* Theme Toggle Button */}
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title="Toggle Theme"
            aria-label="Toggle Theme"
            className={`p-2 rounded-full border transition-colors shadow-sm ${
              theme === 'dark' 
                ? 'bg-neutral-900/60 border-neutral-800 text-neutral-300 hover:text-white' 
                : 'bg-neutral-100 border-neutral-300 text-neutral-800 hover:text-neutral-950'
            }`}
          >
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"></circle>
                <line x1="12" y1="1" x2="12" y2="3"></line>
                <line x1="12" y1="21" x2="12" y2="23"></line>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                <line x1="1" y1="12" x2="3" y2="12"></line>
                <line x1="21" y1="12" x2="23" y2="12"></line>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
              </svg>
            )}
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-6 sm:py-8 flex flex-col">
        
        {/* TAB 1: CHAT INTERFACE */}
        {activeTab === 'chat' && (
          <div className="flex-1 flex flex-col w-full">
            
            {/* Video Input / Setup Box if not loaded */}
            {!videoId && (
              <div className="my-auto space-y-6">
                
                {/* BYOK Callout Banner on Starting Page */}
                <div className={`border rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 transition-colors ${
                  theme === 'dark' ? 'bg-neutral-900/50 border-neutral-700 text-neutral-300' : 'bg-white border-neutral-300 text-neutral-800 shadow-sm'
                }`}>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                      <span className={`text-xs font-semibold uppercase tracking-wider ${theme === 'dark' ? 'text-white' : 'text-neutral-950'}`}>Want better, high-quality outputs?</span>
                    </div>
                    <p className={`text-xs leading-relaxed ${theme === 'dark' ? 'text-neutral-300' : 'text-neutral-700'}`}>
                      Use your own API key (BYOK) for higher rate limits, lower latency, and advanced model routing.
                    </p>
                  </div>
                  <button
                    onClick={() => setActiveTab('help')}
                    className={`whitespace-nowrap text-xs font-medium px-4 py-2 rounded-xl transition-colors cursor-pointer border ${
                      theme === 'dark' ? 'bg-neutral-800 hover:bg-neutral-700 border-neutral-600 text-white' : 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-900'
                    }`}
                  >
                    Configure BYOK &rarr;
                  </button>
                </div>

                {/* Main Setup Card */}
                <div className={`border rounded-2xl p-6 sm:p-8 backdrop-blur-sm transition-colors ${
                  theme === 'dark' ? 'bg-neutral-900/40 border-neutral-700' : 'bg-white border-neutral-300 shadow-md'
                }`}>
                  <div className="max-w-md mx-auto text-center space-y-3 mb-6">
                    <h1 className={`text-2xl font-semibold tracking-tight ${theme === 'dark' ? 'text-white' : 'text-neutral-950'}`}>Chat with any YouTube video</h1>
                    <p className={`text-sm leading-relaxed ${theme === 'dark' ? 'text-neutral-300' : 'text-neutral-700'}`}>
                      Paste a YouTube link below to extract its transcript, index chunks, and query insights instantly using RAG.
                    </p>
                  </div>

                  <form onSubmit={handleIndexVideo} className="space-y-4">
                    <div className="relative">
                      <input 
                        type="text" 
                        value={videoUrl}
                        onChange={(e) => setVideoUrl(e.target.value)}
                        placeholder="https://www.youtube.com/watch?v=..."
                        required
                        className={`w-full border rounded-xl px-4 py-3 text-sm focus:outline-none transition-colors ${
                          theme === 'dark' 
                            ? 'bg-neutral-950 border-neutral-700 text-white placeholder-neutral-500 focus:border-neutral-500' 
                            : 'bg-neutral-50 border-neutral-400 text-neutral-950 placeholder-neutral-500 focus:border-neutral-600'
                        }`}
                      />
                    </div>
                    <button 
                      type="submit"
                      disabled={loading}
                      className={`w-full font-medium py-3 rounded-xl text-sm transition-colors disabled:opacity-50 cursor-pointer ${
                        theme === 'dark' ? 'bg-white hover:bg-neutral-200 text-neutral-950' : 'bg-neutral-900 hover:bg-neutral-800 text-white shadow-sm'
                      }`}
                    >
                      {loading ? 'Processing & Indexing Transcript...' : 'Load & Index Video'}
                    </button>
                  </form>

                  {indexingStatus && (
                    <div className={`mt-4 text-center text-xs ${theme === 'dark' ? 'text-neutral-300' : 'text-neutral-700'}`}>
                      {indexingStatus}
                    </div>
                  )}
                </div>

              </div>
            )}

            {/* Active Chat Interface */}
            {videoId && (
              <div className="flex-1 flex flex-col h-[calc(100vh-10rem)]">
                {/* Active Session Info Header & Active Transcript Notice */}
                <div className={`flex items-center justify-between pb-3 border-b mb-4 text-xs ${
                  theme === 'dark' ? 'border-neutral-800 text-neutral-400' : 'border-neutral-300 text-neutral-700 font-medium'
                }`}>
                  <div className="flex items-center gap-2 truncate">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0"></span>
                    <span className="truncate">Active Video ID: <code className={theme === 'dark' ? 'text-neutral-200 font-mono' : 'text-neutral-950 font-mono font-semibold'}>{videoId}</code></span>
                  </div>
                  <button 
                    onClick={() => { setVideoId(''); setMessages([]); }}
                    className="shrink-0 text-neutral-500 hover:text-neutral-900 dark:hover:text-white transition-colors underline underline-offset-4 ml-2"
                  >
                    Change Video
                  </button>
                </div>

                {/* Session Notice Badge */}
                <div className={`mb-4 px-3 py-2 rounded-xl text-[11px] flex items-center justify-between gap-2 border ${
                  theme === 'dark' ? 'bg-neutral-900/50 border-neutral-800 text-neutral-400' : 'bg-neutral-100 border-neutral-300 text-neutral-600'
                }`}>
                  <span>📌 Active session memory is tied to this processed video transcript. Changing the video starts a fresh session.</span>
                </div>

                {/* Scrollable Chat History */}
                <div className="flex-1 overflow-y-auto space-y-6 pr-2 mb-4">
                  {messages.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-2">
                      <div className={`text-sm font-medium ${theme === 'dark' ? 'text-neutral-300' : 'text-neutral-800'}`}>Video indexed successfully. Ask me anything about its contents.</div>
                      <p className="text-xs text-neutral-500 max-w-xs">Type your question below to query the video transcript using semantic retrieval.</p>
                    </div>
                  )}

                  {messages.map((msg, idx) => (
                    <div 
                      key={idx}
                      className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
                    >
                      <div className={`text-[10px] mb-1 uppercase tracking-wider font-semibold ${
                        theme === 'dark' ? 'text-neutral-400' : 'text-neutral-700'
                      }`}>
                        {msg.role === 'user' ? 'You' : 'YouTubeChat'}
                      </div>
                      <div 
                        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                          msg.role === 'user' 
                            ? (theme === 'dark' ? 'bg-neutral-100 text-neutral-950 font-medium' : 'bg-neutral-900 text-white shadow-sm font-medium')
                            : (theme === 'dark' ? 'bg-neutral-900/90 border border-neutral-700 text-neutral-200' : 'bg-white border border-neutral-400 text-neutral-900 shadow-sm')
                        }`}
                      >
                        <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                      </div>
                    </div>
                  ))}

                  {chatLoading && messages[messages.length - 1]?.content === '' && (
                    <div className="flex flex-col items-start">
                      <div className={`text-[10px] mb-1 uppercase tracking-wider font-semibold ${theme === 'dark' ? 'text-neutral-400' : 'text-neutral-700'}`}>YouTubeChat</div>
                      <div className={`border rounded-2xl px-4 py-3 text-sm animate-pulse ${
                        theme === 'dark' ? 'bg-neutral-900/80 border-neutral-700 text-neutral-300' : 'bg-white border-neutral-400 text-neutral-700 shadow-sm'
                      }`}>
                        Analyzing transcript context...
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Modern Chat Input & Disclaimer */}
                <div className={`space-y-2 pt-2 border-t ${theme === 'dark' ? 'border-neutral-800' : 'border-neutral-300'}`}>
                  <form onSubmit={handleSendMessage} className="relative flex items-center">
                    <input 
                      type="text"
                      value={inputMessage}
                      onChange={(e) => setInputMessage(e.target.value)}
                      placeholder="Ask anything about the video content..."
                      className={`w-full border rounded-2xl pl-4 pr-12 py-3.5 text-sm focus:outline-none transition-colors shadow-sm ${
                        theme === 'dark'
                          ? 'bg-neutral-900/60 border-neutral-700 text-white placeholder-neutral-500 focus:border-neutral-500'
                          : 'bg-white border-neutral-400 text-neutral-950 placeholder-neutral-500 focus:border-neutral-600'
                      }`}
                    />
                    <button 
                      type="submit"
                      disabled={chatLoading || !inputMessage.trim()}
                      className={`absolute right-2.5 w-8 h-8 rounded-xl flex items-center justify-center disabled:opacity-30 transition-opacity cursor-pointer ${
                        theme === 'dark' ? 'bg-white text-neutral-950' : 'bg-neutral-900 text-white shadow-sm'
                      }`}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="19" x2="12" y2="5"></line>
                        <polyline points="5 12 12 5 19 12"></polyline>
                      </svg>
                    </button>
                  </form>

                  {/* AI Disclaimer linked to Info Modal */}
                  <div className="text-center text-[11px] text-neutral-500 flex items-center justify-center gap-1.5">
                    <span>AI can make mistakes.</span>
                    <button 
                      onClick={() => setShowInfoModal(true)}
                      className="underline underline-offset-2 hover:text-neutral-950 dark:hover:text-white transition-colors cursor-pointer font-medium"
                    >
                      Check important information.
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: HELP / HOW IT WORKS & BYOK */}
        {activeTab === 'help' && (
          <div className="space-y-6 sm:space-y-8 py-4">
            <div>
              <h2 className={`text-xl font-semibold tracking-tight mb-2 ${theme === 'dark' ? 'text-white' : 'text-neutral-950'}`}>Help & How It Works</h2>
              <p className={`text-sm leading-relaxed ${theme === 'dark' ? 'text-neutral-300' : 'text-neutral-700'}`}>
                Learn how YouTubeChat processes videos and how you can bring your own custom credentials.
              </p>
            </div>

            <div className="grid gap-4">
              <div className={`border rounded-2xl p-6 transition-colors ${
                theme === 'dark' ? 'bg-neutral-900/40 border-neutral-700' : 'bg-white border-neutral-300 shadow-sm'
              }`}>
                <h3 className={`text-sm font-semibold uppercase tracking-wider mb-4 ${theme === 'dark' ? 'text-white' : 'text-neutral-950'}`}>Workflow Steps</h3>
                <div className={`grid gap-4 text-sm ${theme === 'dark' ? 'text-neutral-300' : 'text-neutral-800'}`}>
                  <div className="flex gap-4">
                    <span className="text-neutral-500 font-mono font-bold">01</span>
                    <div>
                      <strong className={`block mb-0.5 ${theme === 'dark' ? 'text-white' : 'text-neutral-950'}`}>Add a YouTube video</strong>
                      Paste the URL of the video you want to analyze into the chat view.
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <span className="text-neutral-500 font-mono font-bold">02</span>
                    <div>
                      <strong className={`block mb-0.5 ${theme === 'dark' ? 'text-white' : 'text-neutral-950'}`}>Process the video</strong>
                      YouTubeChat retrieves or generates the transcript and prepares the content for semantic search.
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <span className="text-neutral-500 font-mono font-bold">03</span>
                    <div>
                      <strong className={`block mb-0.5 ${theme === 'dark' ? 'text-white' : 'text-neutral-950'}`}>Ask questions</strong>
                      Ask anything about the video&apos;s content through conversational prompts.
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <span className="text-neutral-500 font-mono font-bold">04</span>
                    <div>
                      <strong className={`block mb-0.5 ${theme === 'dark' ? 'text-white' : 'text-neutral-950'}`}>Explore the answer</strong>
                      Get contextual answers generated from the relevant parts of the transcript.
                    </div>
                  </div>
                </div>

                <div className={`mt-6 pt-6 border-t text-xs ${theme === 'dark' ? 'border-neutral-800 text-neutral-300' : 'border-neutral-300 text-neutral-700'}`}>
                  <span className={`font-semibold ${theme === 'dark' ? 'text-white' : 'text-neutral-950'}`}>Underlying Pipeline:</span> Transcription → Chunking → Embeddings → Vector Search → RAG → LLM Response
                </div>
              </div>

              {/* BYOK Configuration Card */}
<div className={`border rounded-2xl p-6 space-y-5 transition-colors ${
  theme === 'dark' ? 'bg-neutral-900/40 border-neutral-700' : 'bg-white border-neutral-300 shadow-sm'
}`}>
  <div className="flex items-center justify-between">
    <div>
      <h3 className={`text-sm font-semibold uppercase tracking-wider mb-1 ${theme === 'dark' ? 'text-white' : 'text-neutral-950'}`}>
        Bring Your Own Key (BYOK)
      </h3>
      <p className={`text-xs leading-relaxed ${theme === 'dark' ? 'text-neutral-300' : 'text-neutral-700'}`}>
        Connect your preferred LLM provider key for higher rate limits and custom model routing. Keys stay in client memory and are never saved to our database.
      </p>
    </div>
  </div>

  <div className="space-y-4">
    {/* Provider Selector */}
    <div className="flex flex-col sm:flex-row gap-3">
      <div className="w-full sm:w-48">
        <label className={`block text-[11px] font-medium uppercase tracking-wider mb-1.5 ${theme === 'dark' ? 'text-neutral-400' : 'text-neutral-600'}`}>
          Provider
        </label>
        <select
          value={selectedProvider}
          onChange={(e) => setSelectedProvider(e.target.value)}
          className={`w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none transition-colors ${
            theme === 'dark'
              ? 'bg-neutral-950 border-neutral-700 text-white'
              : 'bg-neutral-50 border-neutral-400 text-neutral-950'
          }`}
        >
          <option value="auto">Auto-Detect</option>
          <option value="huggingface">Hugging Face</option>
          <option value="groq">Groq</option>
          <option value="openai">OpenAI</option>
          <option value="mistral">Mistral AI</option>
        </select>
      </div>

      {/* Key Input Field with Show/Hide Toggle */}
      <div className="flex-1">
        <label className={`block text-[11px] font-medium uppercase tracking-wider mb-1.5 ${theme === 'dark' ? 'text-neutral-400' : 'text-neutral-600'}`}>
          API Key
        </label>
        <div className="relative flex items-center">
          <input 
            type={showApiKey ? 'text' : 'password'}
            value={userApiKey}
            onChange={(e) => handleKeyChange(e.target.value)}
            placeholder="hf_... or gsk_... or sk-..."
            className={`w-full border rounded-xl pl-4 pr-10 py-2.5 text-sm focus:outline-none transition-colors font-mono ${
              theme === 'dark'
                ? 'bg-neutral-950 border-neutral-700 text-white placeholder-neutral-600 focus:border-neutral-500'
                : 'bg-neutral-50 border-neutral-400 text-neutral-950 placeholder-neutral-400 focus:border-neutral-600'
            }`}
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            className="absolute right-3 text-neutral-400 hover:text-white transition-colors text-xs"
            title={showApiKey ? 'Hide Key' : 'Show Key'}
          >
            {showApiKey ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
    </div>

    {/* Validation Feedback & Action Buttons */}
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-2">
      <div className="text-xs">
        {keyValidationStatus === 'validating' && (
          <span className="text-amber-500 flex items-center gap-1.5 font-medium">
            <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping"></span>
            Verifying API credentials...
          </span>
        )}
        {keyValidationStatus === 'valid' && (
          <span className="text-emerald-500 font-medium">✓ {validationMessage}</span>
        )}
        {keyValidationStatus === 'invalid' && (
          <span className="text-rose-500 font-medium">✕ {validationMessage}</span>
        )}
        {keyValidationStatus === 'idle' && (
          <span className="text-neutral-500">Enter a key above to verify automatically.</span>
        )}
      </div>

      <div className="flex items-center gap-2 w-full sm:w-auto">
        {savedApiKey && (
          <button
            type="button"
            onClick={() => {
              setSavedApiKey('');
              setUserApiKey('');
              setKeyValidationStatus('idle');
              setValidationMessage('');
            }}
            className={`px-3 py-2 rounded-xl text-xs font-medium border transition-colors cursor-pointer ${
              theme === 'dark' ? 'border-neutral-700 text-neutral-300 hover:bg-neutral-800' : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100'
            }`}
          >
            Clear Saved Key
          </button>
        )}
        <button
          type="button"
          onClick={handleSaveApiKey}
          disabled={keyValidationStatus !== 'valid'}
          className={`flex-1 sm:flex-none px-5 py-2 rounded-xl text-xs font-medium disabled:opacity-40 cursor-pointer transition-colors shadow-sm ${
            theme === 'dark' ? 'bg-white text-neutral-950 hover:bg-neutral-200' : 'bg-neutral-900 text-white hover:bg-neutral-800'
          }`}
        >
          {savedApiKey === userApiKey ? 'Key Saved' : 'Save Key'}
        </button>
      </div>
    </div>
  </div>
</div>

              {/* Copyright & Content Notice */}
              <div className={`border rounded-2xl p-6 space-y-2 transition-colors ${
                theme === 'dark' ? 'bg-neutral-900/20 border-neutral-800' : 'bg-neutral-100 border-neutral-300'
              }`}>
                <h4 className={`text-xs font-semibold uppercase tracking-wider ${theme === 'dark' ? 'text-white' : 'text-neutral-950'}`}>Copyright & Content Notice</h4>
                <p className={`text-xs leading-relaxed ${theme === 'dark' ? 'text-neutral-300' : 'text-neutral-700'}`}>
                  YouTubeChat does not claim ownership of videos, transcripts, or other third-party content processed through the service. Content remains the property of its respective creators and rights holders. Users are responsible for ensuring that their use of processed content complies with applicable copyright laws, platform terms, and other applicable policies.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: ABOUT */}
        {activeTab === 'about' && (
          <div className="space-y-6 py-4">
            <div>
              <h2 className={`text-xl font-semibold tracking-tight mb-2 ${theme === 'dark' ? 'text-white' : 'text-neutral-950'}`}>About YouTubeChat</h2>
              <p className={`text-sm leading-relaxed ${theme === 'dark' ? 'text-neutral-300' : 'text-neutral-700'}`}>
                Transforming video content into searchable knowledge through conversational AI and semantic retrieval.
              </p>
            </div>

            <div className={`border rounded-2xl p-6 space-y-4 text-sm leading-relaxed transition-colors ${
              theme === 'dark' ? 'bg-neutral-900/40 border-neutral-700 text-neutral-200' : 'bg-white border-neutral-300 text-neutral-800 shadow-sm'
            }`}>
              <p>
                <strong className={theme === 'dark' ? 'text-white' : 'text-neutral-950'}>YouTubeChat</strong> is an AI-powered conversational interface for YouTube videos. It transforms video content into searchable knowledge, allowing you to ask questions and explore information without manually searching through long videos or transcripts.
              </p>
              <p>
                Designed with a focus on typography, minimalism, and speed, YouTubeChat offers a distraction-free environment for extracting deep insights from educational lectures, tutorials, interviews, and long-form media.
              </p>

              <div className={`pt-4 border-t space-y-2 ${theme === 'dark' ? 'border-neutral-800' : 'border-neutral-300'}`}>
                <h4 className={`text-xs font-semibold uppercase tracking-wider ${theme === 'dark' ? 'text-white' : 'text-neutral-950'}`}>Key Capabilities</h4>
                <ul className={`list-disc list-inside space-y-1 text-xs ${theme === 'dark' ? 'text-neutral-300' : 'text-neutral-700'}`}>
                  <li>Automatic transcript retrieval & parsing</li>
                  <li>Semantic vector embeddings & Retrieval-Augmented Generation (RAG)</li>
                  <li>Contextual multi-turn dialogue history</li>
                  <li>Clean Markdown output support</li>
                </ul>
              </div>
            </div>
          </div>
        )}

      </main>

      {/* Clean Creator Footer (Hidden when actively chatting inside a video session) */}
      {!(activeTab === 'chat' && videoId) && (
        <footer className={`border-t py-6 text-center text-xs tracking-wide mt-auto transition-colors flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-6 ${
          theme === 'dark' ? 'border-neutral-900 text-neutral-400' : 'border-neutral-300 text-neutral-700 bg-white/50 font-medium'
        }`}>
          <span>YouTubeChat · Built by Shantanu</span>
          <div className="flex items-center gap-4">
            <a 
              href="https://github.com/shantanuuh" 
              target="_blank" 
              rel="noopener noreferrer"
              className="hover:underline hover:text-neutral-950 dark:hover:text-white transition-colors"
            >
              GitHub
            </a>
            <span>·</span>
            <a 
              href="https://www.linkedin.com/in/shantanu-harkulkar-563b38269/" 
              target="_blank" 
              rel="noopener noreferrer"
              className="hover:underline hover:text-neutral-950 dark:hover:text-white transition-colors"
            >
              LinkedIn
            </a>
            <span>·</span>
            <a 
              href="https://imshantanu.dev" 
              target="_blank" 
              rel="noopener noreferrer"
              className="hover:underline hover:text-neutral-950 dark:hover:text-white transition-colors"
            >
              Portfolio
            </a>
          </div>
        </footer>
      )}

      {/* Info Modal for "Check important information" */}
      {showInfoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className={`w-full max-w-md border rounded-2xl p-6 space-y-4 shadow-2xl transition-colors ${
            theme === 'dark' ? 'bg-neutral-900 border-neutral-700 text-white' : 'bg-white border-neutral-300 text-neutral-900'
          }`}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">About AI Verification</h3>
              <button 
                onClick={() => setShowInfoModal(false)}
                className="text-neutral-400 hover:text-neutral-950 dark:hover:text-white p-1"
              >
                ✕
              </button>
            </div>
            <p className={`text-xs leading-relaxed ${theme === 'dark' ? 'text-neutral-300' : 'text-neutral-700'}`}>
              Large language models and Retrieval-Augmented Generation (RAG) pipelines summarize transcripts and generate responses based on semantic embeddings. While highly accurate, they can occasionally misinterpret context, omit details, or hallucinate minor facts.
            </p>
            <div className={`p-3 rounded-xl text-xs space-y-1 ${theme === 'dark' ? 'bg-neutral-950 text-neutral-300' : 'bg-neutral-100 text-neutral-800'}`}>
              <span className="font-semibold block">Recommendation:</span>
              For critical academic research, financial decisions, or technical implementation, always verify key timestamps and statements directly against the original YouTube video source.
            </div>
            <button
              onClick={() => setShowInfoModal(false)}
              className={`w-full py-2.5 rounded-xl text-xs font-medium cursor-pointer transition-colors ${
                theme === 'dark' ? 'bg-white text-neutral-950 hover:bg-neutral-200' : 'bg-neutral-900 text-white hover:bg-neutral-800'
              }`}
            >
              Got it
            </button>
          </div>
        </div>
      )}

    </div>
  );
}