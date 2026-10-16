import {useEffect, useState} from 'react';
import {Image} from '@arco-design/web-react';

export function ImagePreview() {
  const [image, setImage] = useState<{src: string; alt: string} | null>(null);
  useEffect(() => {
    const preview = (event: Event) => setImage((event as CustomEvent).detail);
    window.addEventListener('note-image:preview', preview);
    return () => window.removeEventListener('note-image:preview', preview);
  }, []);
  return image && <Image.Preview src={image.src} imgAttributes={{alt: image.alt}} visible onVisibleChange={visible => { if (!visible) setImage(null); }}/>;
}
