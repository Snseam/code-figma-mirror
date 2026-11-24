import React from 'react';

const ManualTag = () => <small data-component="Authored">Unread</small>;
const ForwardProps = props => <aside {...props}>Forwarded</aside>;
const Actions = () => <><button>Open</button><button>Archive</button></>;
const ProxyRow = ({ children }) => children;

export default function Inbox() {
  function MessageRow({ title }) {
    return <article><span>{title}</span></article>;
  }
  return <main>
    <h1>Inbox</h1>
    <MessageRow title="Draft" />
    <ProxyRow><i>Preview</i></ProxyRow>
    <ManualTag />
    <ForwardProps data-component="Caller" />
    <Actions />
  </main>;
}
