<script setup>
import MessageRow from './MessageRow.vue';
import ManualTag from './ManualTag.vue';
import Actions from './Actions.vue';
import ForwardProps from './ForwardProps.vue';
</script>

<template>
  <main>
    <h1>Inbox</h1>
    <MessageRow title="Draft" />
    <ManualTag />
    <ForwardProps data-component="Caller" />
    <Actions />
  </main>
</template>
