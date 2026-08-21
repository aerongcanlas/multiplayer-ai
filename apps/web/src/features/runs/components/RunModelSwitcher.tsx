"use client";

import { isModelKey, type ModelKey } from "@multiplayer-ai/domain";

interface Props {
    value: ModelKey;
    onChange: (value: ModelKey) => void;
}

function RunModelSwitcher({ value, onChange }: Props) {
    return (
        <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">AI model</span>
            <select
                aria-label="AI model"
                className="rounded-md border border-white/15 bg-[#2A2A2A] px-2 py-1 text-sm"
                value={value}
                onChange={(event) => {
                    if (isModelKey(event.target.value)) {
                        onChange(event.target.value);
                    }
                }}
            >
                    <option value="openai:gpt-5-mini">GPT-5 Mini</option>
                    <option value="openai:gpt-5">GPT-5</option>
                    <option value="google:gemini-3.6-flash">Gemini 3.6 Flash</option>
                    <option value="google:gemini-3.5-flash-lite">Gemini 3.5 Flash-Lite</option>
                </select>
        </label>
    );
}

export default RunModelSwitcher;
