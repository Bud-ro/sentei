// Started by the Dockerfile `CMD ["node", "/srv/dist/worker.js"]` (WORKDIR /srv): a
// runtime entry point by convention, mapped from build output to this source.

// Expected: alive, no finding (not exported; called from the entry file top level).
function work(): void {
  console.log('work');
}

work();
