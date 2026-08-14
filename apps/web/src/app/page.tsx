import Link from 'next/link';

function HomePage() {
    return (
        <main className='flex min-h-screen w-full items-center justify-center'>
            <Link
                href='/rooms/room-1'
                className='rounded-md bg-foreground px-5 py-2.5 font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
            >
                Enter Room
            </Link>
        </main>
    );
}

export default HomePage;
