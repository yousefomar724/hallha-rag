import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useRef, useState, type DragEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';

type Phase = 'idle' | 'uploading' | 'processing' | 'done' | 'error';

function formatBytes(n: number): string {
  if (n === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(i > 0 ? 1 : 0)} ${u[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

type FilePendingDelete = { key: string; name: string };

export function KnowledgePage() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | undefined>();
  const [lastFile, setLastFile] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadIndeterminate, setUploadIndeterminate] = useState(false);
  const [filePendingDelete, setFilePendingDelete] = useState<FilePendingDelete | null>(null);

  const {
    data: files = [],
    isLoading: filesLoading,
    isError: filesIsError,
    error: filesError,
    refetch,
    isFetching: filesFetching,
  } = useQuery({
    queryKey: ['knowledge-files'],
    queryFn: async () => {
      const res = await api.listKnowledgeFiles();
      return res.items;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) => api.deleteKnowledgeFile(key),
    onSuccess: () => {
      toast.success('Source removed.');
      setFilePendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['knowledge-files'] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Delete failed.');
    },
  });

  async function upload(file: File) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Only PDF files are accepted.');
      return;
    }
    setLastFile(file.name);
    setPhase('uploading');
    setMessage(undefined);
    setUploadProgress(0);
    setUploadIndeterminate(false);

    try {
      const result = (await api.uploadKnowledge(file, (loaded, total) => {
        if (total <= 0) {
          setUploadIndeterminate(true);
          return;
        }
        const pct = Math.min(100, Math.round((loaded / total) * 100));
        setUploadProgress(pct);
        if (loaded >= total) {
          setPhase('processing');
        }
      })) as { message?: string };
      setPhase('done');
      setMessage(result.message ?? 'Uploaded successfully.');
      toast.success(`${file.name} ingested.`);
      void queryClient.invalidateQueries({ queryKey: ['knowledge-files'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed.';
      setPhase('error');
      setMessage(msg);
      toast.error(msg);
    } finally {
      setUploadIndeterminate(false);
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

  const busy = phase === 'uploading' || phase === 'processing';

  return (
    <div className="max-w-3xl space-y-6">
      <AlertDialog
        open={filePendingDelete != null}
        onOpenChange={(open) => {
          if (!open) setFilePendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove knowledge source?</AlertDialogTitle>
          </AlertDialogHeader>
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>This action cannot be undone</AlertTitle>
            <AlertDescription>
              This will delete{' '}
              <span className="font-medium text-foreground">{filePendingDelete?.name}</span> from
              storage and remove all indexed chunks for this document from the knowledge base.
            </AlertDescription>
          </Alert>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (filePendingDelete) {
                  deleteMutation.mutate(filePendingDelete.key);
                }
              }}
            >
              {deleteMutation.isPending ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <h1 className="text-xl font-semibold">Upload Knowledge</h1>
      <p className="text-sm text-muted-foreground">
        Upload a PDF to ingest into the shared Pinecone knowledge base. Only PDF files are supported.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload PDF</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => !busy && inputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed px-6 py-10 transition-colors ${
              busy ? 'pointer-events-none opacity-60' : 'cursor-pointer'
            } ${
              dragging ? 'border-primary bg-accent' : 'border-muted-foreground/25 hover:border-primary/50'
            }`}
          >
            <span className="text-3xl">📄</span>
            <div className="text-center">
              <p className="text-sm font-medium">
                {busy
                  ? phase === 'processing'
                    ? `Processing ${lastFile ?? ''}…`
                    : `Uploading ${lastFile ?? ''}…`
                  : 'Drag & drop or click to select a PDF'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">PDF only</p>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {phase === 'uploading' && (
            <div className="mt-4 space-y-1">
              {uploadIndeterminate ? (
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
                </div>
              ) : (
                <>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-[width] duration-150"
                      style={{ width: `${uploadProgress ?? 0}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {uploadProgress != null ? `${uploadProgress}%` : ''} — sent to server
                  </p>
                </>
              )}
            </div>
          )}

          {phase === 'processing' && (
            <div className="mt-4 space-y-1">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full w-full animate-pulse bg-primary/70" />
              </div>
              <p className="text-xs text-muted-foreground">Ingesting into knowledge base (S3 + Pinecone)…</p>
            </div>
          )}

          {phase === 'done' && (
            <p className="mt-3 text-sm text-green-600 dark:text-green-400">{message}</p>
          )}
          {phase === 'error' && <p className="mt-3 text-sm text-destructive">{message}</p>}

          {phase !== 'idle' && phase !== 'uploading' && phase !== 'processing' && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => {
                setPhase('idle');
                setLastFile(null);
                setUploadProgress(null);
                setMessage(undefined);
                if (inputRef.current) inputRef.current.value = '';
              }}
            >
              Upload another
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Uploaded files</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            disabled={filesFetching}
          >
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {filesLoading && files.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : filesIsError ? (
            <p className="text-sm text-destructive">
              {filesError instanceof Error ? filesError.message : 'Failed to load uploaded files.'}
            </p>
          ) : files.length === 0 ? (
            <p className="text-sm text-muted-foreground">No PDFs uploaded for this organization yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-end">Size</TableHead>
                  <TableHead className="text-end">Uploaded</TableHead>
                  <TableHead className="text-end">Link</TableHead>
                  <TableHead className="w-[100px] text-end">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((f) => (
                  <TableRow key={f.key}>
                    <TableCell className="font-medium">{f.name}</TableCell>
                    <TableCell className="text-end text-muted-foreground">{formatBytes(f.size)}</TableCell>
                    <TableCell className="text-end text-muted-foreground">{formatDate(f.lastModified)}</TableCell>
                    <TableCell className="text-end">
                      {f.url ? (
                        <a
                          href={f.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary text-sm underline-offset-4 hover:underline"
                        >
                          Open
                        </a>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        disabled={deleteMutation.isPending}
                        onClick={() => setFilePendingDelete({ key: f.key, name: f.name })}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
