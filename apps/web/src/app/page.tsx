import { BoxColumn } from '@/components/ui';
import { Button } from '@/components/ui/Button';
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@/components/ui/Empty';
import Link from 'next/link';

function HomePage() {
    return (
        <main className='flex min-h-screen w-full items-center justify-center'>
            <BoxColumn>
                <Empty className='border border-dashed'>
                    <EmptyHeader>
                        <EmptyMedia variant='icon'>
                            {/* <MessageSquareIcon /> */}
                        </EmptyMedia>
                        <EmptyTitle>No Rooms</EmptyTitle>
                        <EmptyDescription>
                            Create a new room to get started
                        </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                        <Button>
                            <Link href='new'>Create Room</Link>
                        </Button>
                    </EmptyContent>
                </Empty>
                <Link
                    href='/rooms/room-1'
                    className='rounded-md bg-foreground px-5 py-2.5 font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
                >
                    Enter Room
                </Link>
            </BoxColumn>
        </main>
    );
}

export default HomePage;
