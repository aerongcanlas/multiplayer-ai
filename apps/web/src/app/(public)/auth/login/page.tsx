import { LoginForm } from "@/features/auth/components/LoginForm";

interface Props {
    searchParams: Promise<{ next?: string | string[] }>;
}

export default async function Page({ searchParams }: Props) {
    const { next: unsafeNext } = await searchParams;
    const next =
        typeof unsafeNext === "string" &&
        unsafeNext.startsWith("/") &&
        !unsafeNext.startsWith("//")
            ? unsafeNext
            : "/";

    return (
        <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
            <div className="w-full max-w-sm">
                <LoginForm next={next} />
            </div>
        </div>
    );
}
