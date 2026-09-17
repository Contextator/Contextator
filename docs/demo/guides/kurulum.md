---
title: Kurulum Rehberi
---

Bu rehber Contextator'ı Docker ile kurmayı ve ilk projeyi indekslemeyi anlatır.

## Gereksinimler

Sunucuda yalnızca Docker ve Docker Compose bulunması yeterlidir. Gömme (embedding)
modeli uygulama konteynerinin içinde CPU üzerinde çalışır; ilk açılışta otomatik olarak indirilir.

## Docker ile kurulum

```bash
cp .env.example .env
docker compose up -d
docker compose logs -f app
```

Günlükte `embedding model ready` satırını gördüğünüzde sunucu hazırdır. Panel
`http://localhost:3444/` adresinde açılır.

## Belge klasörünü bağlama

`.env` dosyasındaki `DOCS_HOST_PATH` değişkeni ana makinedeki belge klasörünü gösterir ve
konteyner içinde `/docs` olarak bağlanır. Projeler oluşturulurken `/docs/<alt-klasör>`
biçiminde bir yol verilir. Güvenlik nedeniyle `/docs` dışındaki yollar reddedilir.

## Türkçe belgeler için model seçimi

Varsayılan model `Xenova/paraphrase-multilingual-MiniLM-L12-v2` elliden fazla dili, Türkçe
dahil, destekler. Yalnızca İngilizce belgeleriniz varsa `.env` dosyasında
`EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2` seçerek daha küçük ve hızlı bir model kullanabilirsiniz.
İki model de 384 boyutlu vektör üretir; bu yüzden geçiş yapmak için yalnızca projeleri
yeniden indekslemek yeterlidir.

## Yeniden indeksleme

Belgeleri düzenledikten sonra paneldeki **Re-index** düğmesine basın. Yalnızca içeriği
değişen dosyalar yeniden işlenir. **Force** düğmesi tüm parçaları silip projeyi sıfırdan kurar.
