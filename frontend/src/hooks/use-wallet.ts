'use client';
import {useState,useEffect,useCallback} from 'react';
import {connectPasskeyWallet,readPasskeyWallet,passkeyWalletEvent,passkeyWalletStorage} from '@/lib/passkey-wallet';
export interface WalletState { address:string|null; chainId:number|null; label:string|null; connected:boolean; connecting:boolean }
const empty:WalletState={address:null,chainId:null,label:null,connected:false,connecting:false};
export function useWallet(){
 const [state,setState]=useState<WalletState>(empty);
 const update=useCallback(()=>{const w=readPasskeyWallet();setState(w?{address:w.address,chainId:97,label:'Passkey',connected:true,connecting:false}:empty)},[]);
 useEffect(()=>{update();window.addEventListener(passkeyWalletEvent,update);window.addEventListener('storage',update);return()=>{window.removeEventListener(passkeyWalletEvent,update);window.removeEventListener('storage',update)}},[update]);
 const connectAccount=useCallback(async(recover=false):Promise<string|null>=>{
  setState(p=>({...p,connecting:true}));
  try {const existing=readPasskeyWallet();const w=existing&&!recover?existing:await connectPasskeyWallet(recover);update();return w.address;}
  catch {setState(p=>({...p,connecting:false}));return null;}
 },[update]);
 const connect=useCallback(async()=>Boolean(await connectAccount()),[connectAccount]);
 const disconnect=useCallback(async()=>{localStorage.removeItem(passkeyWalletStorage);window.dispatchEvent(new Event(passkeyWalletEvent));},[]);
 return {...state,connect,connectAccount,disconnect};
}
