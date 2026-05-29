import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';

export default function App() {
  const editor = useCreateBlockNote();

  return (
    <div style={{ minHeight: '100vh', padding: '2rem', maxWidth: '800px', margin: '0 auto' }}>
      <h1 style={{ fontFamily: 'Inter, sans-serif', marginBottom: '1rem' }}>Obscura</h1>
      <BlockNoteView editor={editor} />
    </div>
  );
}
