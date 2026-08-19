'use client';

type ChatProvider = 'gemini' | 'openai';

interface Props {
    value: ChatProvider;
    onChange: (value: ChatProvider) => void;
}

function ModelSwitcher({ value, onChange }: Props) {
    return (
        <label className='flex items-center gap-2 text-sm'>
            <span className='sr-only'>AI model</span>
            <select
                aria-label='AI model'
                className='rounded-md border border-white/15 bg-[#2A2A2A] px-2 py-1 text-sm'
                value={value}
                onChange={(event) =>
                    onChange(event.target.value as ChatProvider)
                }
            >
                <option value='gemini'>Gemini 3.6 Flash</option>
                <option value='openai'>OpenAI GPT-5 Mini</option>
            </select>
        </label>
    );
}

export type { ChatProvider };
export default ModelSwitcher;
