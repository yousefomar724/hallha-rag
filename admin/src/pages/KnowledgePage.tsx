import { useRef, useState, type DragEvent } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';

type UploadState = { status: 'idle' | 'uploading' | 'done' | 'error'; message?: string };

export function KnowledgePage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState<UploadState>({ status: 'idle' });
  const [lastFile, setLastFile] = useState<string | null>(null);

  async function upload(file: File) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Only PDF files are accepted.');
      return;
    }
    setLastFile(file.name);
    setState({ status: 'uploading' });
    try {
      const result = await api.uploadKnowledge(file) as { message?: string };
      setState({ status: 'done', message: result.message ?? 'Uploaded successfully.' });
      toast.success(`${file.name} ingested.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed.';
      setState({ status: 'error', message: msg });
      toast.error(msg);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void upload(file);
  }

  function handleFileChange() {
    const file = inputRef.current?.files?.[0];
    if (file) void upload(file);
  }

  return (
    <div className="space-y-6 max-w-xl">
      <h1 className="text-xl font-semibold">Upload Knowledge</h1>
      <p className="text-sm text-muted-foreground">
        Upload a PDF to ingest into the shared Pinecone knowledge base. Only PDF files are supported.
      </p>

      <Card>
        <CardHeader><CardTitle className="text-base">Upload PDF</CardTitle></CardHeader>
        <CardContent>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed cursor-pointer px-6 py-10 transition-colors ${
              dragging ? 'border-primary bg-accent' : 'border-muted-foreground/25 hover:border-primary/50'
            } ${state.status === 'uploading' ? 'pointer-events-none opacity-60' : ''}`}
          >
            <span className="text-3xl">📄</span>
            <div className="text-center">
              <p className="text-sm font-medium">
                {state.status === 'uploading' ? `Uploading ${lastFile ?? ''}…` : 'Drag & drop or click to select a PDF'}
              </p>
              <p className="text-xs text-muted-foreground mt-1">PDF only</p>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {state.status === 'done' && (
            <p className="mt-3 text-sm text-green-600 dark:text-green-400">{state.message}</p>
          )}
          {state.status === 'error' && (
            <p className="mt-3 text-sm text-destructive">{state.message}</p>
          )}

          {state.status !== 'idle' && state.status !== 'uploading' && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => { setState({ status: 'idle' }); setLastFile(null); }}
            >
              Upload another
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
