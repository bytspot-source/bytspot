import React from 'react';
import { SafeAreaView, View, TextInput, Text, Button, FlatList } from 'react-native';

export default function ConciergeChat() {
  const [messages, setMessages] = React.useState<any[]>([
    { id: 'sys1', role: 'assistant', text: 'Hi! I can help you find the perfect spot or plan valet. What are you in the mood for?' }
  ]);
  const [input, setInput] = React.useState('');
  const send = () => {
    if (!input.trim()) return;
    const userMsg = { id: 'u' + Date.now(), role: 'user', text: input };
    setMessages(prev => [...prev, userMsg, { id: 'sys' + Date.now(), role: 'assistant', text: 'Great choice! Try checking this venue.' }]);
    setInput('');
  };
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <FlatList style={{ flex: 1, padding: 12 }} data={messages} keyExtractor={m=>m.id} renderItem={({ item }) => (
        <View style={{ alignSelf: item.role === 'assistant' ? 'flex-start' : 'flex-end', backgroundColor: item.role==='assistant'? '#eee':'#cce5ff', borderRadius: 12, padding: 10, marginVertical: 4, maxWidth: '80%' }}>
          <Text>{item.text}</Text>
        </View>
      )} />
      <View style={{ flexDirection: 'row', padding: 8 }}>
        <TextInput style={{ flex: 1, borderWidth: 1, borderRadius: 8, padding: 8, marginRight: 8 }} value={input} onChangeText={setInput} placeholder="Ask Concierge..." />
        <Button title="Send" onPress={send} />
      </View>
    </SafeAreaView>
  );
}

