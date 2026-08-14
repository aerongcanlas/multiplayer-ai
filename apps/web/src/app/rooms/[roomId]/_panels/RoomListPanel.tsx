import { BoxColumn, Separator, TextBox } from '@/components/ui';

function RoomListPanel() {
    const rooms: Array<string> = ['room 1', 'room 2'];
    return (
        <BoxColumn className='h-full w-full shrink-0'>
            <TextBox className='px-2 py-2'>New Room</TextBox>
            <Separator />
            <BoxColumn className='py-2'>
                {rooms.map((room, index) => (
                    <TextBox
                        key={index}
                        className='px-2'
                    >
                        {room}
                    </TextBox>
                ))}
            </BoxColumn>
        </BoxColumn>
    );
}
export default RoomListPanel;
