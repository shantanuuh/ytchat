'use client';

import { useState, useEffect } from 'react';
import { Settings, Key, Cpu } from 'lucide-react';

interface ModelSettingsProps {
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  userApiKey: string;
  setUserApiKey: (key: string) => void;
}

export default function ModelSettings({
  selectedModel,
  setSelectedModel,
  userApiKey,
  setUserApiKey,
}: ModelSettingsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [tempKey, setTempKey] = useState(userApiKey);

  // Load saved key from localStorage on mount
  useEffect(() => {
    const savedKey = localStorage.getItem('yt_rag_user_key');
    if (savedKey) setUserApiKey(savedKey);
  }, [setUserApiKey]);

  const handleSaveKey = () => {
    setUserApiKey(tempKey);
    localStorage.setItem('yt_rag_user_key', tempKey);
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg border border-zinc-700 transition-colors"
      >
        <Settings className="w-4 h-4" />
        <span>Config</span>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-4 z-50 text-zinc-200">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Cpu className="w-4 h-4 text-indigo-400" /> Model & BYOK Settings
            </h3>
            <button
              onClick={() => setIsOpen(false)}
              className="text-zinc-400 hover:text-white text-sm"
            >
              ✕
            </button>
          </div>

          {/* Model Selection */}
          <div className="mb-4">
            <label className="block text-xs font-medium text-zinc-400 mb-1">
              Select Inference Model
            </label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 text-sm rounded-lg p-2 text-zinc-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="llama-3.3-70b-versatile">Free Tier (Llama 3.3 70B via Groq)</option>
              <option value="gpt-4o-mini">BYOK: GPT-4o Mini (Requires OpenAI Key)</option>
              <option value="gpt-4o">BYOK: GPT-4o (Requires OpenAI Key)</option>
            </select>
          </div>

          {/* BYOK Input */}
          <div className="mb-3">
            <label className="block text-xs font-medium text-zinc-400 mb-1 flex items-center gap-1">
              <Key className="w-3.5 h-3.5" /> Bring Your Own Key (Optional)
            </label>
            <input
              type="password"
              placeholder="sk-..."
              value={tempKey}
              onChange={(e) => setTempKey(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 text-sm rounded-lg p-2 text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[10px] text-zinc-500 mt-1">
              Your key stays locally in your browser and is never saved on our servers.
            </p>
          </div>

          <button
            onClick={handleSaveKey}
            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium py-2 rounded-lg transition-colors"
          >
            Save Configuration
          </button>
        </div>
      )}
    </div>
  );
}