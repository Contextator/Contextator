# Kubernetes üzerinde çalıştırma

Halyard kopyaları durumsuzdur ve birbirleriyle yalnızca veritabanı üzerinden haberleşirler. Bu yüzden
Kubernetes tarafında ihtiyaç duyulan şey sıradan bir `Deployment`'tır; `StatefulSet` gerekmez, kopyaların
birbirini tanıması ya da sabit bir kimliğe sahip olması gerekmez.

## Helm ile

```bash
helm repo add halyard https://charts.halyard.dev
helm upgrade --install halyard halyard/halyard \
  --version 2.7.0 \
  --set replicaCount=3 \
  --set database.existingSecret=halyard-db \
  --set signing.existingSecret=halyard-signing \
  --set persistence.spool.storageClass=nfs-shared
```

Grafikteki değerlerin tamamı ortam değişkenlerine dönüştürülür; grafiğin kendine ait bir yapılandırma
sözlüğü yoktur. Bir ayarın karşılığını merak ettiğinizde ortam değişkenleri başvurusuna bakmanız
yeterlidir.

## Yük havuzunun paylaşılması

`HALYARD_DATA_DIR`, gövdesi `HALYARD_PAYLOAD_INLINE_LIMIT` sınırını aşan olayların yazıldığı dizindir ve
varsayılan olarak her kopyaya özeldir. Kopyaya özel bırakıldığında, büyük gövdeli bir olayın gönderimi
yalnızca gövdeyi yazmış olan kopya tarafından üstlenilebilir; o kopya kalıcı olarak yok olursa ilgili
gönderimler bir sonraki denemede `HLY-1001` ile başarısız olur.

İkiden fazla kopya çalıştıracaksanız bu dizini `ReadWriteMany` bir birimde paylaştırın. Paylaştırılmış
bir havuz, gönderimlerin kopyalara sabitlenmesi gereğini tamamen ortadan kaldırır.

```yaml
persistence:
  spool:
    enabled: true
    accessModes: ["ReadWriteMany"]
    size: 20Gi
```

## Yoklama uçları

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 8480 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /readyz, port: 8480 }
  periodSeconds: 5
```

İki ucun ayrılması önemlidir. `/healthz` yalnızca sürecin ayakta olduğunu söyler; `/readyz` ise
veritabanının erişilebilir ve şemanın beklenen sürümde olduğunu söyler. İkisini de aynı uca
bağlarsanız, veritabanının kısa süreli erişilemezliği bütün kapsayıcıların yeniden başlatılmasına yol
açar — yani düzelmesi beklenen bir aksaklık, düzelmesini engelleyen bir döngüye dönüşür.

## Düzgün kapanma

```yaml
terminationGracePeriodSeconds: 90
env:
  - name: HALYARD_DRAIN_TIMEOUT
    value: 60s
```

`terminationGracePeriodSeconds` değeri `HALYARD_DRAIN_TIMEOUT` değerinden belirgin biçimde büyük
olmalıdır. Kubernetes `SIGTERM` gönderdiğinde sunucu yeni iş almayı bırakır, elindeki gönderimlerin
bitmesini bekler ve süre dolduğunda kalanları bırakır; bırakılan gönderimler kaybolmaz, kiralamaları
dolduğunda başka bir kopya tarafından yeniden denenir.

## Göç işlemleri

Grafik, göçleri bir `initContainer` içinde çalıştırır. Üç kopya aynı anda başlatıldığında üçü de
`halyardctl migrate` çalıştırır; danışma kilidini yalnızca biri alır, diğer ikisi bekler ve ardından
yapacak bir şey bulamayıp çıkar. Göç başarısız olursa kapsayıcı sıfırdan farklı bir kodla çıkar ve
`Deployment` yeni sürüme geçemez — yarım uygulanmış bir şemayla hizmet vermektense yükseltmenin
durması tercih edilmiştir.

Bir `Job` ile ayrıca göç çalıştırmanız gerekmez; çalıştırırsanız da zararsızdır, çünkü göç komutu
yeniden çalıştırılmaya dayanıklıdır.
