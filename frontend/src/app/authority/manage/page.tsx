'use client';
import {useEffect} from 'react';
import {useRouter} from 'next/navigation';
export default function ManageAuthorityPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/dashboard?panel=authority'); }, [router]);
  return <p className="p-6 font-mono text-sm">Opening wallet permissions in Dashboard…</p>;
}
