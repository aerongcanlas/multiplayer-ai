"use client";
import { Box, Button, Card, Input, Spinner } from "@/components/ui";
import {
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/Card";
import {
    Field,
    FieldError,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { createRoom } from "@/features/rooms/actions/createRoom";
import { createRoomSchema } from "@/features/rooms/schema";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { Controller, useForm } from "react-hook-form";
import z from "zod";

type FormData = z.infer<typeof createRoomSchema>;

function NewRoomPage() {
    const form = useForm<FormData>({
        defaultValues: {
            name: "",
        },
        resolver: zodResolver(createRoomSchema),
    });

    async function handleSubmit(data: FormData) {
        const { error, message } = await createRoom(data);

        if (error) {
            toast.add({ type: "error", description: message });
        }
    }

    return (
        <Box className="flex min-h-screen w-full items-center justify-center">
            <Card className="w-1/2">
                <CardHeader>
                    <CardTitle>New Room</CardTitle>
                    <CardDescription>
                        Create a new multiplayer room
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={form.handleSubmit(handleSubmit)}>
                        <FieldGroup>
                            <Controller
                                name="name"
                                control={form.control}
                                render={({ field, fieldState }) => (
                                    <Field data-invalid={fieldState.invalid}>
                                        <FieldLabel htmlFor={field.name}>
                                            Room Name
                                        </FieldLabel>
                                        <Input
                                            {...field}
                                            id={field.name}
                                            aria-invalid={fieldState.invalid}
                                        />
                                        <FieldError
                                            errors={[fieldState.error]}
                                        />
                                    </Field>
                                )}
                            />
                        </FieldGroup>
                        <Field
                            orientation="horizontal"
                            className="mt-2"
                        >
                            <Button
                                type="submit"
                                className="grow"
                                disabled={form.formState.isSubmitting}
                            >
                                <Box className="relative">
                                    {form.formState.isSubmitting && (
                                        <Spinner className="absolute top-1/2 right-[calc(100%+0.375rem)] -translate-y-1/2" />
                                    )}
                                    Create Room
                                </Box>
                            </Button>
                            <Button variant="outline">
                                <Link href="/">Cancel</Link>
                            </Button>
                        </Field>
                    </form>
                </CardContent>
            </Card>
        </Box>
    );
}
export default NewRoomPage;
