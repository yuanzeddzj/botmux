# Group mentions with selected thread exceptions

Set `groupMentionRequired: true` on a Bot to require a direct mention of that Bot in group messages. Add exact group IDs to `mentionlessThreadChats` to allow replies inside existing native threads in those groups without another mention. Group top-level messages still require a mention. One-to-one direct messages retain their normal mentionless behavior.

```json
{
  "groupMentionRequired": true,
  "mentionlessThreadChats": ["oc_your_group_id"],
  "exclusiveTopicOwner": true
}
```

The thread exception does not grant access or select every Bot in the group. Talk permissions and topic ownership continue to apply: first mention a Bot to establish the topic owner, then replies go only to that owner. Mentioning another Bot retains the existing handoff protocol.

The required-mention boundary takes precedence over group mention defaults, solo-group shortcuts, sessionless commands and message listeners. Incoming message edits, recovered messages, listener polling and delayed dispatch use the same boundary. Clearing the exception list keeps required group mentions enabled. With `groupMentionRequired` unset or false, existing routing is preserved.

Both fields are configurable through `/botconfig` and trusted daemon IPC. The policy affects new message triggers; scheduled work and already-admitted turns retain their existing authorization.
