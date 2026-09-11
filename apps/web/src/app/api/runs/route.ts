import {
    deleteRun,
    getRun,
    postRun,
} from "@/features/runs/server/runRoute";

export const runtime = "nodejs";
// Max duration for web; depends on Vercel Plan; increase for tool/app
export const maxDuration = 300;

export async function POST(request: Request) {
    return postRun(request);
}

export async function GET(request: Request) {
    return getRun(request);
}

export async function DELETE(request: Request) {
    return deleteRun(request);
}
