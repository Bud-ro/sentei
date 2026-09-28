<script setup lang="ts">
import { fetchUser } from '@/api/client';
const user = fetchUser();
</script>

<template>
  <p>{{ user }}</p>
</template>
