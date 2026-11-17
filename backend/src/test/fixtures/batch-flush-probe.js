import { BatchFlush } from '@/utils/bounded-cache';

const batch = new BatchFlush(() => {
    globalThis.__flushed = (globalThis.__flushed || 0) + 1;
});
batch.schedule();
globalThis.__batch = batch;
