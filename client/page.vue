<template>
  <k-layout>
    <k-card>
      <k-card-content>
        <p>
          This bot is responsible for syncing the Oni database with the latest
          data from the game. It runs every hour and updates the database with
          any new information it finds.
        </p>
        <p>
          If you have any questions or issues with the bot, please contact the
          developers.
        </p>
        <p>
          {{ 1 }}
        </p>
      </k-card-content>
    </k-card>
  </k-layout>
</template>

<script lang="ts">
import { store } from '@koishijs/client'
</script>
