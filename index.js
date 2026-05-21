const express = require('express')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3001

function extractPlaceId(url) {
  const match = url.match(/place\/(\d+)/)
  if (match) return match[1]
  const match2 = url.match(/[?&]id=(\d+)/)
  if (match2) return match2[1]
  return null
}

async function expandNaverUrl(shortUrl) {
  try {
    const res = await fetch(shortUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
      }
    })
    return res.url
  } catch {
    return shortUrl
  }
}

async function fetchReviews(placeId, maxReviews = 50) {
  const reviews = []
  let page = 1

  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': `https://pcmap.place.naver.com/restaurant/${placeId}/review/visitor`,
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  }

  while (reviews.length < maxReviews && page <= 10) {
    try {
      const url = `https://pcmap-api.place.naver.com/place/graphql`
      const body = [{
        operationName: 'getVisitorReviews',
        variables: {
          input: {
            businessId: placeId,
            businessType: 'restaurant',
            item: '0',
            bookingBusinessId: null,
            page,
            size: 10,
            isPhotoUsed: false,
            includeSuper: true,
            getUserStats: true,
            includeRank: true,
            cidList: [],
          }
        },
        query: `query getVisitorReviews($input: VisitorReviewsInput) {
          visitorReviews(input: $input) {
            items {
              id
              body
              rating
              author {
                nickname
              }
              created
            }
            totalCount
            __typename
          }
        }`
      }]

      const res = await fetch(url, {
        method: 'POST',
        headers: { ...commonHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        console.log(`API 응답 실패: ${res.status}`)
        break
      }

      const data = await res.json()
      const items = data?.[0]?.data?.visitorReviews?.items || []

      console.log(`페이지 ${page}: ${items.length}개 리뷰`)

      if (items.length === 0) break

      for (const item of items) {
        if (item.body?.trim()) reviews.push(item.body.trim())
      }

      page++
      await new Promise(r => setTimeout(r, 500))
    } catch (err) {
      console.error(`페이지 ${page} 오류:`, err.message)
      break
    }
  }

  return reviews.slice(0, maxReviews)
}

async function fetchPlaceInfo(placeId) {
  try {
    const url = `https://pcmap-api.place.naver.com/place/graphql`
    const body = [{
      operationName: 'getRestaurant',
      variables: {
        input: { businessId: placeId }
      },
      query: `query getRestaurant($input: RestaurantInput) {
        restaurant(input: $input) {
          name
          category
          address
          phone
          businessHours { businessStatus { status } description }
          visitorReviewsScore
        }
      }`
    }]

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Referer': `https://pcmap.place.naver.com/restaurant/${placeId}/home`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) return null
    const data = await res.json()
    return data?.[0]?.data?.restaurant || null
  } catch {
    return null
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '네이버 리뷰 크롤러 서버 v3' })
})

app.post('/crawl', async (req, res) => {
  try {
    let { url, maxReviews = 50 } = req.body

    if (!url) return res.status(400).json({ error: 'URL을 입력해주세요' })

    const isNaverUrl = url.includes('map.naver.com') || url.includes('naver.me') || url.includes('place.naver.com')
    if (!isNaverUrl) return res.status(400).json({ error: '네이버 지도 URL만 지원합니다' })

    if (url.includes('naver.me/')) {
      url = await expandNaverUrl(url)
      console.log(`단축 URL 확장: ${url}`)
    }

    const placeId = extractPlaceId(url)
    if (!placeId) return res.status(400).json({ error: 'URL에서 가게 ID를 찾을 수 없습니다' })

    console.log(`시작: placeId=${placeId}`)
    const start = Date.now()

    const [info, reviews] = await Promise.all([
      fetchPlaceInfo(placeId),
      fetchReviews(placeId, Math.min(maxReviews, 100)),
    ])

    console.log(`완료: ${reviews.length}개 리뷰, ${Date.now() - start}ms`)

    res.json({
      success: true,
      placeId,
      data: {
        name: info?.name || '가게 이름',
        category: info?.category || '',
        address: info?.address || '',
        phone: info?.phone || '',
        hours: info?.businessHours?.description || '',
        rating: String(info?.visitorReviewsScore || ''),
        reviewCount: reviews.length,
        reviews,
        reviewsText: reviews.join('\n'),
      },
    })
  } catch (err) {
    console.error('오류:', err)
    res.status(500).json({ error: '처리 중 오류: ' + err.message })
  }
})

app.listen(PORT, () => {
  console.log(`크롤러 서버 v3 실행 중: http://localhost:${PORT}`)
})
