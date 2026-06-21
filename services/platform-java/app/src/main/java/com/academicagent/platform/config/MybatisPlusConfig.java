package com.academicagent.platform.config;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.context.annotation.Configuration;

@Configuration
@MapperScan({
    "com.academicagent.platform.identity.mapper",
    "com.academicagent.platform.research.mapper"
})
public class MybatisPlusConfig {
}
