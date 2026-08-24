"use client";

import type { SendMessageResult } from "@/features/rooms/types/room";
import { zodResolver } from "@hookform/resolvers/zod";
import {
    createMessageSchema,
    type CreateMessageInput,
} from "@multiplayer-ai/domain";
import { useRef } from "react";
import { useForm } from "react-hook-form";
import { Button, Input, toast } from "./ui";

interface Props {
    disabled: boolean;
    onSend: (text: string) => Promise<SendMessageResult>;
}

type FormData = Pick<CreateMessageInput, "text">;
const formSchema = createMessageSchema.pick({ text: true });

function ChatMessageInput({ disabled, onSend }: Props) {
    const inputRef = useRef<HTMLInputElement>(null);
    const form = useForm<FormData>({
        defaultValues: {
            text: "",
        },
        resolver: zodResolver(formSchema),
    });
    const textField = form.register("text");

    async function handleSendMessage(data: FormData) {
        try {
            const res = await onSend(data.text);

            if (!res.success) {
                toast.add({ type: "error", description: res.error });
                return;
            }

            form.reset();
        } finally {
            requestAnimationFrame(() => inputRef.current?.focus());
        }
    }

    return (
        <form
            className="flex items-center gap-2 rounded-2xl border bg-card p-2"
            onSubmit={form.handleSubmit(handleSendMessage)}
        >
            <Input
                {...textField}
                aria-label="Message"
                ref={(element) => {
                    textField.ref(element);
                    inputRef.current = element;
                }}
                maxLength={1_000}
                placeholder={disabled ? "Connecting..." : "Send a message"}
                disabled={disabled || form.formState.isSubmitting}
                className="min-w-0 flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0"
            />

            <Button
                type="submit"
                disabled={disabled || form.formState.isSubmitting}
                onPointerDown={(event) => event.preventDefault()}
                className="shrink-0 rounded-xl"
            >
                Send
            </Button>
        </form>
    );
}
export default ChatMessageInput;
